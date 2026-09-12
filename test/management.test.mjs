import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { createHost } from '../src/server.mjs';
import { digest } from '../src/session.mjs';
import { saveReceipt,flushReceipts } from '../src/completion-receipts.mjs';

async function setup(t){
  const dir=await mkdtemp(path.join(os.tmpdir(),'hih-management-')),root=path.join(dir,'project'),dataDir=path.join(dir,'state');await mkdir(root);
  let host=await createHost({port:0,workspace:root,dataDir,allowLocalAgent:false});
  t.after(async()=>{await host.close();await rm(dir,{recursive:true,force:true});});
  const call=async(route,p,token)=>{const r=await fetch(host.url+route,{method:p===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:p===undefined?undefined:JSON.stringify(p)});return {status:r.status,data:await r.json()};};
  const owner=(await call('/api/bootstrap',{})).data;
  const member=async(role='member')=>{const invite=(await call('/api/invites',{role},owner.token)).data;return (await call('/api/join',{code:invite.code,name:role})).data;};
  const agent=async person=>{const code=(await call('/api/pairing',{},person.token)).data.code,worker=(await call('/api/agent/pair',{code})).data;assert.equal((await call('/api/worker/register',{runnerId:person.member.id,protocolVersion:3,account:person.member.name},worker.token)).status,200);return worker.token;};
  const claim=async(person,worker,prompt='Continue')=>{const sent=await call('/api/turns',{prompt,requestId:randomUUID()},person.token);assert.equal(sent.status,200);return (await call('/api/worker/claim',{runnerId:person.member.id},worker)).data.job;};
  return {get host(){return host;},dir,root,dataDir,owner,member,agent,claim,call,restart:async()=>{await host.close();host=await createHost({port:0,dataDir,allowLocalAgent:false});}};
}
function payload(job){const nativeId=job.nativeId||randomUUID(),checkpoint=(job.checkpoint||JSON.stringify({type:'session_meta',payload:{id:nativeId}})+'\n')+JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:job.prompt}]}})+'\n';return {lease:job.lease,nativeId,checkpoint,status:'completed',nativeThreads:{}};}
const receipt=(job,p)=>({turnId:job.id,payload:p,hash:digest(p.checkpoint)});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<80;i++){try{if(await fn())return;}catch{}await pause(100);}throw new Error('Condition did not become true');}

test('receipt recovers an unacknowledged completed turn after failure and restart; duplicates never advance revision',async t=>{
  const f=await setup(t),worker=await f.agent(f.owner),job=await f.claim(f.owner,worker),p=payload(job),outbox=path.join(f.dir,'agent');
  await saveReceipt(outbox,job.id,p);
  await f.call(`/api/worker/turns/${job.id}/fail`,{lease:job.lease,error:'connection dropped after Codex closed'},worker);
  await f.restart();assert.ok(f.host.store.state.blocked);
  let calls=0;const send=async(route,body)=>{calls++;const result=await f.call(route,body,worker);assert.equal(result.status,200,JSON.stringify(result.data));return result.data;};
  await flushReceipts(outbox,send);assert.equal(calls,1);assert.equal(f.host.store.state.revision,1);assert.equal(f.host.store.state.nativeId,p.nativeId);assert.equal(f.host.store.state.checkpoint,p.checkpoint);assert.equal(f.host.store.state.blocked,null);
  assert.equal((await readdir(path.join(outbox,'receipts'))).length,0);
  assert.equal((await send('/api/worker/receipt',receipt(job,p))).alreadyCommitted,true);assert.equal(f.host.store.state.revision,1);
  assert.equal((await f.call('/api/worker/receipt',receipt(job,{...p,checkpoint:p.checkpoint+'\n'}),worker)).status,400);
  assert.equal((await f.call('/api/session/new',{title:'second'},f.owner.token)).status,200);
  assert.equal((await send('/api/worker/receipt',receipt(job,p))).alreadyCommitted,true);assert.equal(f.host.store.state.revision,0);
});

test('receipt verifies author, lease, original prefix and children; a failed delivery keeps the local outbox',async t=>{
  const f=await setup(t),b=await f.member(),worker=await f.agent(f.owner),other=await f.agent(b),job=await f.claim(f.owner,worker),p=payload(job),outbox=path.join(f.dir,'agent');
  const child=randomUUID();p.nativeThreads[child]=JSON.stringify({type:'session_meta',payload:{id:child}})+'\n';
  await saveReceipt(outbox,job.id,p);await assert.rejects(flushReceipts(outbox,async()=>{throw new Error('offline');}),/offline/);assert.equal((await readdir(path.join(outbox,'receipts'))).length,1);
  assert.equal((await f.call('/api/worker/receipt',receipt(job,p),other)).status,403);
  assert.equal((await f.call('/api/worker/receipt',receipt(job,{...p,lease:'forged'}),worker)).status,403);
  assert.equal((await f.call('/api/worker/receipt',receipt(job,p),worker)).status,200);
  const next=await f.claim(f.owner,worker),bad=payload(next);bad.checkpoint=bad.checkpoint.replace('Continue','Changed');
  assert.equal((await f.call('/api/worker/receipt',receipt(next,bad),worker)).status,400);assert.equal(f.host.store.state.checkpoint,p.checkpoint);
  const valid=payload(next);assert.equal((await f.call('/api/worker/receipt',receipt(next,valid),worker)).status,200);assert.equal(f.host.store.state.nativeThreads[child],p.nativeThreads[child]);
});

test('workspace selection persists across restart, archives history, revokes other members and binds uploads',async t=>{
  const f=await setup(t),b=await f.member(),second=path.join(f.dir,'second');await mkdir(second);await writeFile(path.join(second,'index.html'),'second');
  const oldId=f.host.store.state.id,upload=(await f.call('/api/uploads',{name:'old.txt',size:0,hash:digest('')},f.owner.token)).data;
  assert.equal((await f.call('/api/workspace/inspect',{path:second},b.token)).status,403);
  assert.equal((await f.call('/api/workspace/inspect',{path:f.dataDir},f.owner.token)).status,400);
  assert.equal((await f.call('/api/workspace/inspect',{path:f.dir},f.owner.token)).status,400);
  const inspected=(await f.call('/api/workspace/inspect',{path:second},f.owner.token)).data;
  assert.equal(inspected.files[0].path,'index.html');
  assert.equal((await f.call('/api/workspace/open',{path:second,hash:'stale'},f.owner.token)).status,400);
  assert.equal((await f.call('/api/workspace/open',{path:second,hash:inspected.hash},f.owner.token)).status,200);
  assert.notEqual(f.host.store.state.id,oldId);assert.equal((await f.call('/api/state',undefined,b.token)).status,401);
  assert.equal((await f.call(`/api/uploads/${upload.id}/complete`,{},f.owner.token)).status,400);
  assert.equal((await f.call(`/api/session/archives/${oldId}/resume`,{},f.owner.token)).status,400);
  await f.restart();assert.equal(f.host.files.root,await realpath(second));assert.equal((await f.call('/api/file?path=index.html',undefined,f.owner.token)).data.content,'second');
});

test('archive resumption preserves native ID, current files and current memberships; queue edits and cancellation reach native input',async t=>{
  const f=await setup(t),worker=await f.agent(f.owner),job=await f.claim(f.owner,worker),p=payload(job);await f.call(`/api/worker/turns/${job.id}/complete`,p,worker);
  const old=f.host.store.state.id;await f.call('/api/session/new',{title:'second'},f.owner.token);const b=await f.member();await writeFile(path.join(f.root,'current.txt'),'stay current');
  assert.equal((await f.call(`/api/session/archives/${old}/resume`,{},f.owner.token)).status,200);assert.equal(f.host.store.state.nativeId,p.nativeId);assert.ok(f.host.store.state.participants.some(m=>m.id===b.member.id));assert.equal(await readFile(path.join(f.root,'current.txt'),'utf8'),'stay current');
  const queued=(await f.call('/api/turns',{prompt:'old instruction',requestId:'edit'},f.owner.token)).data.turn;
  assert.equal((await f.call(`/api/turns/${queued.id}/edit`,{expectedPrompt:'old instruction',prompt:'new instruction'},b.token)).status,403);
  assert.equal((await f.call(`/api/turns/${queued.id}/edit`,{expectedPrompt:'old instruction',prompt:'new instruction'},f.owner.token)).status,200);
  assert.equal((await f.call(`/api/turns/${queued.id}/edit`,{expectedPrompt:'old instruction',prompt:'stale'},f.owner.token)).status,400);
  const cancelled=(await f.call('/api/turns',{prompt:'do not do this',requestId:'cancel'},f.owner.token)).data.turn;await f.call(`/api/turns/${cancelled.id}/cancel`,{},f.owner.token);
  const next=(await f.call('/api/worker/claim',{runnerId:f.owner.member.id},worker)).data.job;
  for(const text of ['old instruction','new instruction','do not do this','session-resume'])assert.ok(next.prompt.includes(text));assert.equal(next.nativeId,p.nativeId);assert.equal(next.checkpoint,p.checkpoint);
  assert.equal((await f.call(`/api/worker/turns/${next.id}/complete`,payload(next),worker)).status,200);
});

test('active revocation immediately blocks reading and new tools but allows the original turn to stop and save',async t=>{
  const f=await setup(t),b=await f.member(),worker=await f.agent(b),job=await f.claim(b,worker),p=payload(job);
  const result=await f.call(`/api/members/${b.member.id}/revoke`,{},f.owner.token);assert.equal(result.status,200);assert.equal(result.data.pending,true);
  assert.equal((await f.call('/api/state',undefined,b.token)).status,401);
  assert.equal((await f.call(`/api/worker/turns/${job.id}/exec/open`,{lease:job.lease},worker)).status,403);
  assert.equal((await f.call('/api/worker/claim',{runnerId:b.member.id},worker)).status,403);
  assert.equal((await f.call(`/api/worker/turns/${job.id}/heartbeat`,{lease:job.lease},worker)).data.cancel,true);
  assert.equal((await f.call(`/api/worker/turns/${job.id}/complete`,{...p,status:'interrupted'},worker)).status,200);
  assert.equal(f.host.store.state.revision,1);assert.equal(f.host.store.state.blocked,null);assert.equal((await f.call('/api/worker/register',{},worker)).status,401);
});

test('managed npm server checks reviewed script, streams Unicode output, stops its process tree and shuts down with host',async t=>{
  const f=await setup(t),probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  await writeFile(path.join(f.root,'dev.mjs'),`import http from 'node:http'; console.log('준비 완료'); http.createServer((q,r)=>r.end('managed server')).listen(${port},'127.0.0.1');`);
  await writeFile(path.join(f.root,'package.json'),JSON.stringify({scripts:{dev:'node dev.mjs'}}));
  const catalog=(await f.call('/api/dev-server/scripts',undefined,f.owner.token)).data;
  assert.equal((await f.call('/api/dev-server/start',{script:'dev',expectedHash:'stale',port},f.owner.token)).status,400);
  assert.equal((await f.call('/api/dev-server/start',{script:'dev',expectedHash:catalog.hash,port},f.owner.token)).status,200);
  await until(async()=>await(await fetch('http://127.0.0.1:'+port)).text()==='managed server');
  await until(async()=>(await f.call('/api/state',undefined,f.owner.token)).data.devServer.log.includes('준비 완료'));
  assert.equal((await f.call('/api/dev-server/start',{script:'dev',expectedHash:catalog.hash,port},f.owner.token)).status,400);
  assert.equal((await f.call('/api/dev-server/stop',{},f.owner.token)).status,200);await assert.rejects(fetch('http://127.0.0.1:'+port));
  assert.equal((await f.call('/api/dev-server/start',{script:'dev',expectedHash:catalog.hash,port},f.owner.token)).status,200);await until(async()=>(await fetch('http://127.0.0.1:'+port)).ok);
  await f.restart();await assert.rejects(fetch('http://127.0.0.1:'+port));assert.equal((await f.call('/api/state',undefined,f.owner.token)).data.devServer.status,'stopped');
  const second=path.join(f.dir,'second');await mkdir(second);const selected=(await f.call('/api/workspace/inspect',{path:second},f.owner.token)).data;
  assert.equal((await f.call('/api/workspace/open',{path:second,hash:selected.hash},f.owner.token)).status,200);
  const b=await f.member(),state=(await f.call('/api/state',undefined,b.token)).data;assert.equal(state.devServer.log,'');assert.equal(state.devServer.script,null);assert.equal(state.devServer.command,undefined);
});

test('failed atomic disk commit cannot acknowledge or discard the only completed receipt; final UI events recover',async t=>{
  const f=await setup(t),worker=await f.agent(f.owner),job=await f.claim(f.owner,worker),p=payload(job);
  p.finalEvents=[{kind:'message',item:{id:'final-answer',type:'agentMessage',text:'저장된 최종 응답',phase:'final'}},{kind:'nativeTool',phase:'completed',item:{id:'command',type:'commandExecution',status:'completed',exitCode:0,aggregatedOutput:'saved tool output'}}];
  const save=f.host.store.save.bind(f.host.store);let failOnce=true;
  f.host.store.save=()=>{if(failOnce&&f.host.store.state.revision===1){failOnce=false;throw new Error('disk write failed');}return save();};
  assert.equal((await f.call(`/api/worker/turns/${job.id}/complete`,p,worker)).status,400);
  assert.equal(f.host.store.state.revision,0);assert.equal(f.host.store.state.turns[0].committedRevision,undefined);assert.equal(JSON.parse(await readFile(path.join(f.dataDir,'session.json'),'utf8')).revision,0);
  const retry=await f.call('/api/worker/receipt',receipt(job,p),worker);assert.equal(retry.status,200,JSON.stringify(retry.data));assert.equal(retry.data.recovered,true);
  assert.equal(f.host.store.state.turns[0].items[0].text,'저장된 최종 응답');assert.equal(f.host.store.state.turns[0].tools[0].result.output.aggregatedOutput,'saved tool output');
  assert.equal((await f.call('/api/worker/receipt',receipt(job,{...p,finalEvents:[]}),worker)).status,400);
  assert.equal((await f.call('/api/worker/receipt',receipt(job,p),worker)).data.alreadyCommitted,true);assert.equal(f.host.store.state.revision,1);
});

test('revoked worker can settle only its original receipt after failed save, including an unresponsive cancellation',async t=>{
  const f=await setup(t),b=await f.member(),worker=await f.agent(b),job=await f.claim(b,worker),p=payload(job);
  await f.call(`/api/members/${b.member.id}/revoke`,{},f.owner.token);f.host.store.active.revokeDeadline=Date.now()-1;
  assert.equal((await f.call(`/api/worker/turns/${job.id}/heartbeat`,{lease:job.lease},worker)).data.cancel,true);
  await until(()=>f.host.store.state.participants.find(m=>m.id===b.member.id).revoked);assert.ok(f.host.store.state.blocked);
  assert.equal((await f.call(`/api/worker/turns/${job.id}/heartbeat`,{lease:job.lease},worker)).status,401);
  assert.equal((await f.call('/api/worker/receipt',receipt(job,p),worker)).status,200);assert.equal(f.host.store.state.blocked,null);
  assert.equal((await f.call('/api/worker/receipt',receipt(job,p),worker)).data.alreadyCommitted,true);
  assert.equal((await f.call('/api/worker/claim',{runnerId:b.member.id},worker)).status,401);
  assert.equal((await f.call('/api/state',undefined,b.token)).status,401);
});
