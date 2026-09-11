import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHost } from '../src/server.mjs';
import { Workspace } from '../src/workspace.mjs';
import {digest,LEGACY_COMPACTION_ERROR} from '../src/session.mjs';
import {nativeId,original,interrupted} from './fixtures/native-session.mjs';
async function fixture(t){const dir=await mkdtemp(path.join(os.tmpdir(),'hih-host-'));const root=path.join(dir,'workspace');await mkdir(root);await writeFile(path.join(root,'index.html'),'<html><body>Original</body></html>');const host=await createHost({port:0,dataDir:path.join(dir,'state'),workspace:root,allowLocalAgent:false});t.after(async()=>{await host.close();await rm(dir,{recursive:true,force:true});});const call=async(route,p,token)=>{const r=await fetch(host.url+route,{method:p===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`} : {})},body:p===undefined?undefined:JSON.stringify(p)});return {status:r.status,data:await r.json()};};return {host,call,dir,root};}
test('invite and pairing are one-use; credentials enforce author, runner, lease and revocation',async t=>{
  const {call}=await fixture(t);
  assert.equal((await call('/api/state')).status,401);
  const owner=(await call('/api/bootstrap',{})).data;
  const invite=(await call('/api/invites',{},owner.token)).data;
  const b=(await call('/api/join',{code:invite.code,name:'B'})).data;
  assert.equal((await call('/api/join',{code:invite.code,name:'C'})).status,403);
  const code=(await call('/api/pairing',{},b.token)).data.code;
  const agent=(await call('/api/agent/pair',{code})).data;
  assert.equal((await call('/api/agent/pair',{code})).status,403);
  await call('/api/worker/register',{runnerId:'b-runner',protocolVersion:2,account:'B account'},agent.token);
  await call('/api/turns',{prompt:'Read original',requestId:'b1'},b.token);
  assert.equal((await call('/api/worker/claim',{runnerId:'forged'},agent.token)).status,409);
  const {job}=(await call('/api/worker/claim',{runnerId:'b-runner'},agent.token)).data;
  assert.equal(job.authorId,b.member.id);
  assert.equal((await call(`/api/worker/turns/${job.id}/applied`,{lease:'forged',revision:0,hash:job.baseHash,nativeId:'n'},agent.token)).status,400);
  await call(`/api/worker/turns/${job.id}/applied`,{lease:job.lease,revision:0,hash:job.baseHash,nativeId:'n'},agent.token);
  const args={lease:job.lease,callId:'read1',name:'host_read_file',args:{path:'index.html'}};
  const result=await call(`/api/worker/turns/${job.id}/tool`,args,agent.token);assert.equal(result.data.output.content,'<html><body>Original</body></html>');
  const duplicate=await call(`/api/worker/turns/${job.id}/tool`,args,agent.token);assert.deepEqual(duplicate.data,result.data);
  const state=(await call('/api/state',undefined,owner.token)).data;assert.equal(state.turns[0].tools.length,1);assert.ok(!JSON.stringify(state).includes(agent.token));assert.ok(!JSON.stringify(state).includes(job.lease));
  await call(`/api/worker/turns/${job.id}/fail`,{lease:job.lease,error:'test interruption'},agent.token);
  await call(`/api/members/${b.member.id}/revoke`,{},owner.token);
  assert.equal((await call('/api/state',undefined,b.token)).status,401);
  assert.equal((await call('/api/worker/claim',{runnerId:'b-runner'},agent.token)).status,401);
});
test('host writes detect stale hashes; path escapes, secrets and directory junctions are refused',async t=>{
  const {root,dir}=await fixture(t),files=new Workspace(root);
  const first=await files.read('index.html');
  await files.write({path:'index.html',content:'<html><body>Changed</body></html>',expectedHash:first.hash});
  await assert.rejects(files.write({path:'index.html',content:'stale overwrite',expectedHash:first.hash}),/충돌/);
  assert.equal((await files.read('index.html')).content,'<html><body>Changed</body></html>');
  for(const name of ['../outside','C:\\Windows\\file','.env','.git/config','a/../../outside','file:ads','NUL.txt','trailing.'])await assert.rejects(files.resolve(name,true));
  const outside=path.join(dir,'outside');await mkdir(outside);await writeFile(path.join(outside,'private.txt'),'private');
  try{await symlink(outside,path.join(root,'link'),process.platform==='win32'?'junction':'dir');await assert.rejects(files.read('link/private.txt'),/링크|junction/);}catch(error){if(error.code!=='EPERM')throw error;}
  assert.equal(await readFile(path.join(outside,'private.txt'),'utf8'),'private');
});
test('JavaScript validation is syntax-only and does not execute project code',async t=>{
  const {root}=await fixture(t),files=new Workspace(root);
  await writeFile(path.join(root,'safe.js'),'throw new Error("MUST NOT EXECUTE");');
  assert.equal((await files.validate('safe.js')).ok,true);
  await writeFile(path.join(root,'broken.js'),'const = invalid;');assert.equal((await files.validate('broken.js')).ok,false);
});
test('API rejects cross-origin bootstrap and private files are never static assets',async t=>{
  const {host}=await fixture(t);
  const result=await fetch(host.url+'/api/bootstrap',{method:'POST',headers:{Origin:'https://untrusted.example'},body:'{}'});assert.equal(result.status,403);
  assert.equal((await fetch(host.url+'/.hih/session.json')).status,404);
});

test('writer-conflict retry preserves history, is author-only, and is idempotent over HTTP',async t=>{
  const {host,call}=await fixture(t);
  const owner=(await call('/api/bootstrap',{})).data;
  const invite=(await call('/api/invites',{},owner.token)).data;
  const b=(await call('/api/join',{code:invite.code,name:'B'})).data;
  const code=(await call('/api/pairing',{},b.token)).data.code;
  const agent=(await call('/api/agent/pair',{code})).data;
  await call('/api/worker/register',{runnerId:'b-runner',protocolVersion:2,account:'B account'},agent.token);
  const nativeId='11111111-1111-4111-8111-111111111111';
  const checkpoint=JSON.stringify({type:'session_meta',payload:{id:nativeId}})+'\n';
  const {digest}=await import('../src/session.mjs');
  Object.assign(host.store.state,{nativeId,checkpoint,checkpointHash:digest(checkpoint),revision:1});host.store.save();
  await call('/api/turns',{prompt:'Continue the same conversation',requestId:'b1'},b.token);
  const {job}=(await call('/api/worker/claim',{runnerId:'b-runner'},agent.token)).data;
  assert.equal((await call(`/api/worker/turns/${job.id}/fail`,{lease:job.lease,error:`thread ${nativeId} already has an active writer (-32600)`,failurePhase:'resume_rejected'},agent.token)).status,200);
  assert.equal(host.store.state.blocked,null);
  assert.equal((await call(`/api/turns/${job.id}/retry`,{},owner.token)).status,403);
  const first=await call(`/api/turns/${job.id}/retry`,{},b.token);
  const duplicate=await call(`/api/turns/${job.id}/retry`,{},b.token);
  assert.equal(first.status,200);assert.equal(first.data.turn.id,duplicate.data.turn.id);
  assert.equal(host.store.state.turns.length,2);assert.equal(host.store.state.checkpoint,checkpoint);
});

test('old runners are refused before claiming a turn',async t=>{
  const {call}=await fixture(t),owner=(await call('/api/bootstrap',{})).data;
  const code=(await call('/api/pairing',{},owner.token)).data.code;
  const agent=(await call('/api/agent/pair',{code})).data;
  const registration={runnerId:'old-runner',account:'A account'};
  const result=await call('/api/worker/register',registration,agent.token);
  assert.equal(result.status,409);assert.match(result.data.error,/업데이트/);
  assert.equal((await call('/api/worker/claim',{runnerId:registration.runnerId},agent.token)).status,409);
  assert.equal((await call('/api/worker/register',{...registration,protocolVersion:2},agent.token)).status,200);
});

test('only the failed author runner can recover its checkpoint; replay and revoked credentials are refused',async t=>{
  const {host,call}=await fixture(t),owner=(await call('/api/bootstrap',{})).data;
  const invite=(await call('/api/invites',{},owner.token)).data;
  const b=(await call('/api/join',{code:invite.code,name:'B'})).data;
  const pair=async token=>(await call('/api/agent/pair',{code:(await call('/api/pairing',{},token)).data.code})).data.token;
  const ownerAgent=await pair(owner.token),bAgent=await pair(b.token);
  Object.assign(host.store.state,{nativeId,checkpoint:original,checkpointHash:digest(original),revision:4});host.store.save();
  const turn=host.store.enqueue(b.member,'Recall the other person.','b1');host.store.claim(b.member.id,'b-runner','B account','b');
  Object.assign(turn,{status:'running',nativeId,appliedHash:digest(original),appliedRevision:4});host.store.fail(turn,LEGACY_COMPACTION_ERROR);
  assert.equal((await call('/api/worker/recovery')).status,401);
  assert.equal((await call('/api/worker/recovery',undefined,b.token)).status,401);
  assert.deepEqual((await call('/api/worker/recovery',undefined,ownerAgent)).data.turns,[]);
  assert.deepEqual((await call('/api/worker/recovery',undefined,bAgent)).data.turns,[{id:turn.id,nativeId}]);
  const payload={turnId:turn.id,checkpoint:original+interrupted()};
  assert.equal((await call('/api/worker/recovery',payload,ownerAgent)).status,400);
  assert.equal((await call('/api/worker/recovery',{...payload,checkpoint:original},bAgent)).status,400);
  assert.ok(host.store.state.blocked);
  assert.equal((await call('/api/worker/recovery',payload,bAgent)).status,200);
  assert.equal(host.store.state.blocked,null);assert.equal(host.store.state.checkpoint,payload.checkpoint);
  assert.equal((await call('/api/worker/recovery',payload,bAgent)).status,400);
  assert.equal((await call(`/api/turns/${turn.id}/retry`,{},owner.token)).status,403);
  assert.equal((await call(`/api/turns/${turn.id}/retry`,{},b.token)).status,200);
  await call(`/api/members/${b.member.id}/revoke`,{},owner.token);
  assert.equal((await call('/api/worker/recovery',undefined,bAgent)).status,401);
});
