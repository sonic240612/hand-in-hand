import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { createHost } from '../src/server.mjs';
import { createRelay, relayOrigin, validRelayPath } from '../src/relay.mjs';

async function fixture(t) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'hih-relay-')),root=path.join(dir,'workspace'),key=randomBytes(32).toString('base64url');
  await mkdir(root);await writeFile(path.join(root,'index.html'),'<html><body>Shared original</body></html>');
  const relay=await createRelay({port:0,key,pollMs:100});
  const host=await createHost({port:0,dataDir:path.join(dir,'state'),workspace:root,allowLocalAgent:false,relay:{url:relay.url,key}});
  t.after(async()=>{await host.close();await relay.close();await rm(dir,{recursive:true,force:true});});
  const call=async(base,route,body,token,extra={})=>{
    const res=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`} : {}),...extra},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(7000)});
    return {status:res.status,data:await res.json()};
  };
  const owner=(await call(host.url,'/api/bootstrap',{})).data;
  for(let i=0;i<100;i++){if((await call(host.url,'/api/state',undefined,owner.token)).data.remoteAccess.connected)break;await sleep(20);}
  assert.equal((await call(host.url,'/api/state',undefined,owner.token)).data.remoteAccess.connected,true);
  return {host,relay,owner,key,call,dir,root};
}

test('real reverse relay blocks uninvited users and remote owner bootstrap, even with forged proxy headers',async t=>{
  const {host,relay,owner,call,key}=await fixture(t);
  assert.equal((await fetch(relay.url+'/')).status,200);
  for(const route of ['/api/state','/api/files','/api/file?path=index.html'])assert.equal((await call(relay.url,route)).status,401);
  assert.equal((await call(relay.url,'/api/bootstrap',{})).status,403);
  assert.equal((await call(relay.url,'/api/bootstrap',{},undefined,{'X-Forwarded-For':'127.0.0.1','Tailscale-User-Login':'owner@example.test'})).status,403);
  assert.equal((await call(host.url,'/api/bootstrap',{},undefined,{'X-Forwarded-For':'127.0.0.1'})).status,403);
  assert.equal((await call(relay.url,'/api/local-agent',{},owner.token)).status,403);
  assert.equal((await call(relay.url,'/api/state',undefined,owner.token)).data.canLocalConnect,false);
  assert.equal((await call(relay.url,'/api/join',{code:'invalid',name:'stranger'})).status,403);
  assert.equal((await call(relay.url,'/api/state',undefined,owner.token,{Origin:'https://untrusted.example'})).status,403);
  assert.equal((await call(relay.url,'/_relay/next')).status,401);
  assert.equal((await call(relay.url,'/_relay/connect',{},'wrong-key',{'X-Hih-Connector':randomUUID()})).status,401);
  assert.equal((await call(relay.url,'/_relay/connect',{},key,{'X-Hih-Connector':randomUUID()})).status,409);
  assert.equal((await fetch(relay.url+'/.hih/session.json')).status,404);
});

test('invited remote browser and runner share one host session, stream changes, write files, and lose access on revoke',async t=>{
  const {host,relay,owner,call,root}=await fixture(t);
  const invitation=(await call(host.url,'/api/invites',{},owner.token)).data;
  assert.equal(invitation.url,relay.url);
  const guest=(await call(relay.url,'/api/join',{code:invitation.code,name:'Remote B'})).data;
  assert.equal((await call(relay.url,'/api/join',{code:invitation.code,name:'Duplicate'})).status,403);
  const initial=(await call(relay.url,'/api/state',undefined,guest.token)).data;
  assert.equal(initial.id,host.store.state.id);
  const abort=new AbortController();t.after(()=>abort.abort());
  const events=await fetch(relay.url+'/api/events',{headers:{Authorization:`Bearer ${guest.token}`},signal:abort.signal});
  assert.match(events.headers.get('content-type'),/text\/event-stream/);
  const reader=events.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/event: state/);
  const pair=(await call(relay.url,'/api/pairing',{},guest.token)).data;
  const agent=(await call(relay.url,'/api/agent/pair',{code:pair.code})).data;
  assert.equal((await call(relay.url,'/api/agent/pair',{code:pair.code})).status,403);
  await call(relay.url,'/api/worker/register',{runnerId:'remote-runner',protocolVersion:3,account:'test-account'},agent.token);
  const prompt='Keep the original shared session and write via the host.';
  const queued=(await call(relay.url,'/api/turns',{prompt,requestId:'remote-1'},guest.token)).data;
  const repeated=(await call(relay.url,'/api/turns',{prompt,requestId:'remote-1'},guest.token)).data;
  assert.equal(repeated.turn.id,queued.turn.id);
  const {job}=(await call(relay.url,'/api/worker/claim',{runnerId:'remote-runner'},agent.token)).data;
  await call(relay.url,`/api/worker/turns/${job.id}/applied`,{lease:job.lease,hash:job.baseHash,revision:0,nativeId:'native-relay-session'},agent.token);
  const prefix=`/api/worker/turns/${job.id}`;
  const previous=(await call(relay.url,prefix+'/tool',{lease:job.lease,callId:'read',name:'host_read_file',args:{path:'index.html'}},agent.token)).data;
  const content='<html><body>Changed through the relay</body></html>';
  const written=await call(relay.url,prefix+'/tool',{lease:job.lease,callId:'write',name:'host_write_file',args:{path:'index.html',expectedHash:previous.output.hash,content}},agent.token);
  assert.equal(written.data.success,true);assert.equal(await readFile(path.join(root,'index.html'),'utf8'),content);
  const checkpoint=[{type:'session_meta',payload:{id:'native-relay-session'}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:prompt}]}}].map(x=>JSON.stringify(x)+'\n').join('');
  assert.equal((await call(relay.url,prefix+'/complete',{lease:job.lease,nativeId:'native-relay-session',checkpoint,status:'completed'},agent.token)).status,200);
  assert.equal(host.store.state.checkpoint,checkpoint);
  assert.equal((await call(relay.url,'/api/state',undefined,guest.token)).data.nativeId,'native-relay-session');
  let streamed='';for(let i=0;i<40&&!streamed.includes('native-relay-session');i++){const next=await reader.read();if(next.done)break;streamed+=new TextDecoder().decode(next.value);}assert.match(streamed,/native-relay-session/);
  await call(host.url,`/api/members/${guest.member.id}/revoke`,{},owner.token);
  assert.equal((await call(relay.url,'/api/state',undefined,guest.token)).status,401);
  assert.equal((await call(relay.url,'/api/worker/claim',{runnerId:'remote-runner'},agent.token)).status,401);
  abort.abort();
});

test('relay reports offline honestly and validates transport and paths',async t=>{
  const key=randomBytes(32).toString('base64url'),relay=await createRelay({port:0,key});t.after(()=>relay.close());
  const response=await fetch(relay.url+'/api/state');assert.equal(response.status,503);assert.match((await response.json()).error,/오프라인/);
  for(const url of ['http://public.example','https://example.test/path','https://user:pass@example.test','https://example.test/#secret'])assert.throws(()=>relayOrigin(url));
  assert.equal(relayOrigin('https://relay.example.test'),'https://relay.example.test');
  for(const value of ['//another-host/','/../private','/%2e%2e/private','/_relay/connect','/\\another-host','https://other.test'])assert.equal(validRelayPath(value),false);
  assert.equal(validRelayPath('/api/file?path=index.html'),true);
});
