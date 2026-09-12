import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { abortableDelay,createConnectionRetry,isTransientConnectionError } from '../src/connection-retry.mjs';
import { runAgent } from '../src/agent.mjs';
import { saveReceipt } from '../src/completion-receipts.mjs';
import { digest } from '../src/session.mjs';
import { nativeId,original,message } from './fixtures/native-session.mjs';

test('connection retries cap backoff and log disconnect and recovery only once',async()=>{
  const delays=[],logs=[];let calls=0;
  const retry=createConnectionRetry({sleep:async ms=>delays.push(ms),log:message=>logs.push(message)});
  assert.equal(await retry(async()=>{if(calls++<7)throw Object.assign(new Error('offline'),{status:503});return 'ready';}),'ready');
  assert.deepEqual(delays,[1000,2000,4000,8000,10000,10000,10000]);
  assert.equal(logs.length,2);
  await retry(async()=>true);assert.equal(logs.length,2);
  let once=true;await retry(async()=>{if(once){once=false;throw Object.assign(new Error('offline'),{code:'ECONNRESET'});}});
  assert.equal(delays.at(-1),1000);assert.equal(logs.length,4);
});

test('retry excludes permission, native validation, abort and non-temporary HTTP failures',async()=>{
  for(const error of [new Error('checkpoint changed'),new DOMException('abort','AbortError'),...[400,401,403,404,409,422].map(status=>Object.assign(new Error('rejected'),{status}))]){
    let calls=0;
    await assert.rejects(createConnectionRetry({sleep:()=>assert.fail('permanent failure was retried')})(async()=>{calls++;throw error;}),failure=>failure===error);
    assert.equal(calls,1);assert.equal(isTransientConnectionError(error),false);
  }
  for(const status of [408,429,500,502,503,504,599])assert.equal(isTransientConnectionError({status}),true);
  assert.equal(isTransientConnectionError({cause:{code:'ECONNREFUSED'}}),true);
  assert.equal(isTransientConnectionError({status:403,connectionFailure:true}),false);
});

test('abort interrupts backoff immediately without another attempt',async()=>{
  const controller=new AbortController(),reason=new Error('user stopped');let calls=0;
  const retry=createConnectionRetry({signal:controller.signal,log:()=>queueMicrotask(()=>controller.abort(reason))});
  await assert.rejects(retry(async()=>{calls++;throw Object.assign(new Error('offline'),{status:503});}),failure=>failure===reason);
  assert.equal(calls,1);
  await assert.rejects(async()=>abortableDelay(10000,controller.signal),failure=>failure===reason);
});

async function fixture(t,{saved=true}={}){
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'hih-connection-test-'));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const host='http://127.0.0.1:12345',controller=new AbortController(),events=[],logs=[];
  if(saved)await writeFile(path.join(dataDir,'connection.json'),JSON.stringify({host,token:'test-agent-token'}));
  const rpcFactory=async()=>{
    events.push('probe');
    return {initialize:async()=>({userAgent:'test-runtime'}),request:async method=>{assert.equal(method,'account/read');events.push('account');return {account:{type:'chatgpt',email:'test@example.com',planType:'plus'}};},close:async()=>events.push('probe/close')};
  };
  return {host,dataDir,signal:controller.signal,controller,events,logs,rpcFactory,log:message=>logs.push(message),retrySleep:async ms=>events.push('wait:'+ms)};
}
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

test('saved connection retries receipt upload before probing, registering or claiming',async t=>{
  const f=await fixture(t);let receipts=0,ready=0;
  await saveReceipt(f.dataDir,'test-completed-turn',{checkpoint:'retained native checkpoint'});
  await runAgent({...f,onReady:()=>ready++,fetchImpl:async(url,options)=>{
    const route=new URL(url).pathname;f.events.push(route);
    assert.equal(options.headers.Authorization,'Bearer test-agent-token');
    if(route==='/api/worker/receipt')return ++receipts===1?new Response('maintenance',{status:503}):json({ok:true});
    if(route==='/api/worker/register')return json({ok:true});
    if(route==='/api/worker/recovery')return json({turns:[]});
    if(route==='/api/worker/claim'){f.controller.abort();return json({job:null});}
    assert.fail(route);
  }});
  assert.deepEqual(f.events,['/api/worker/receipt','wait:1000','/api/worker/receipt','probe','account','probe/close','/api/worker/register','/api/worker/recovery','/api/worker/claim']);
  assert.equal(ready,1);
  await assert.rejects(readFile(path.join(f.dataDir,'receipts','test-completed-turn.json')),error=>error.code==='ENOENT');
});

test('saved connection retries an offline host and host restart without consuming pairing code',async t=>{
  const f=await fixture(t);let registrations=0,claims=0;
  await runAgent({...f,fetchImpl:async url=>{
    const route=new URL(url).pathname;f.events.push(route);
    if(route==='/api/worker/register'){
      if(++registrations===1)throw new TypeError('fetch failed',{cause:{code:'ECONNREFUSED'}});
      return json({ok:true});
    }
    if(route==='/api/worker/recovery')return json({turns:[]});
    if(route==='/api/worker/claim'){
      if(++claims===1)return json({error:'register again'},409);
      f.controller.abort();return json({job:null});
    }
    assert.fail(route);
  }});
  assert.equal(registrations,3);assert.equal(claims,2);
  assert.deepEqual(f.events.filter(event=>event.startsWith('wait:')),['wait:1000']);
  assert.equal(f.events.filter(event=>event==='account').length,3);
});

test('revoked or invalid recovery stops explicitly and retains the completion receipt',async t=>{
  for(const status of [401,403,400]){
    const f=await fixture(t);await saveReceipt(f.dataDir,'pending',{checkpoint:'native original'});
    let calls=0;
    await assert.rejects(runAgent({...f,fetchImpl:async()=>{calls++;return json({error:'permission or checkpoint rejected'},status);}}),error=>error.status===status);
    assert.equal(calls,1);assert.equal(f.events.length,0);
    assert.ok(await readFile(path.join(f.dataDir,'receipts','pending.json'),'utf8'));
  }
});

test('one-time pairing is never replayed after an uncertain network response',async t=>{
  const f=await fixture(t,{saved:false});let calls=0;
  await assert.rejects(runAgent({...f,pair:'single-use',fetchImpl:async url=>{
    assert.equal(new URL(url).pathname,'/api/agent/pair');calls++;
    throw new TypeError('fetch failed');
  }}),/fetch failed/);
  assert.equal(calls,1);assert.equal(f.events.length,0);
});

test('Ctrl+C aborts an in-flight host request and closes the probe without retrying',async t=>{
  const f=await fixture(t);let calls=0;
  await runAgent({...f,fetchImpl:async(url,options)=>{
    calls++;queueMicrotask(()=>f.controller.abort());
    return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
  }});
  assert.equal(calls,1);assert.ok(f.events.includes('probe/close'));
  assert.equal(f.events.some(event=>event.startsWith('wait:')),false);
});

test('a lost native failure report is acknowledged before any next claim heartbeat',async t=>{
  const f=await fixture(t);let claims=0,failures=0,resumes=0;
  class FakeRpc extends EventEmitter{
    async initialize(){return {userAgent:'fake-runtime'};}
    async close(){f.events.push('native/close');}
    async request(method,params){
      if(method==='account/read')return {account:{type:'chatgpt',email:'test@example.com',planType:'plus'}};
      if(method==='thread/resume'){resumes++;return {thread:{id:nativeId,path:params.path,historyMode:'legacy'}};}
      assert.fail('Native turn must not start: '+method);
    }
  }
  await runAgent({...f,rpcFactory:async()=>new FakeRpc(),fetchImpl:async url=>{
    const route=new URL(url).pathname;f.events.push(route);
    if(route==='/api/worker/register')return json({ok:true});
    if(route==='/api/worker/recovery')return json({turns:[]});
    if(route==='/api/worker/claim'){
      if(++claims===1)return json({job:{id:'failed-native-turn',checkpoint:original,nativeId,baseHash:digest(original),baseRevision:1,lease:'lease',authorName:'Tester',authorId:'test',prompt:'Continue'}});
      assert.equal(failures,3,'next claim cannot keep an unacknowledged active turn alive');
      f.controller.abort();return json({job:null});
    }
    if(route.endsWith('/applied'))return json({error:'offline'},503);
    if(route.endsWith('/fail')){failures++;return failures<3?json({error:'offline'},503):json({ok:true});}
    assert.fail(route);
  }});
  assert.equal(resumes,1);assert.equal(claims,2);
  assert.equal(f.events.indexOf('native/close')<f.events.lastIndexOf('/api/worker/turns/failed-native-turn/fail'),true);
  assert.deepEqual(f.events.filter(event=>event.startsWith('wait:')),['wait:1000']);
});

test('completed native output settles its receipt before retrying a lost failure report',async t=>{
  const f=await fixture(t);let claims=0,failures=0,receipts=0,starts=0;
  class FakeRpc extends EventEmitter{
    async initialize(){return {userAgent:'fake-runtime'};}
    async close(){this.closed=true;}
    async request(method,params){
      if(method==='account/read')return {account:{type:'chatgpt',email:'test@example.com',planType:'plus'}};
      if(method==='thread/resume'){this.file=params.path;return {thread:{id:nativeId,path:this.file,historyMode:'legacy'}};}
      if(method==='turn/start'){
        starts++;await writeFile(this.file,original+message('user',params.input[0].text)+message('assistant','Finished once.'));
        this.emit('notification',{method:'turn/completed',params:{threadId:nativeId,turn:{id:'native-turn',status:'completed'}}});
        return {turn:{id:'native-turn'}};
      }
      assert.fail(method);
    }
  }
  await runAgent({...f,rpcFactory:async()=>new FakeRpc(),fetchImpl:async(url,options)=>{
    const route=new URL(url).pathname;f.events.push(route);
    if(route==='/api/worker/register')return json({ok:true});
    if(route==='/api/worker/recovery')return json({turns:[]});
    if(route==='/api/worker/claim'){
      if(++claims===1)return json({job:{id:'completed-native-turn',checkpoint:original,nativeId,baseHash:digest(original),baseRevision:1,lease:'lease',authorName:'Tester',authorId:'test',prompt:'Continue'}});
      assert.equal(receipts,2);assert.equal(failures,2);f.controller.abort();return json({job:null});
    }
    if(route.endsWith('/applied'))return json({ok:true});
    if(route.endsWith('/complete'))return json({error:'lost completion response'},503);
    if(route.endsWith('/fail')){failures++;return failures===1?json({error:'offline'},503):json({ok:true,alreadySettled:true});}
    if(route==='/api/worker/receipt'){
      receipts++;assert.match(JSON.parse(options.body).payload.checkpoint,/Finished once/);
      return receipts===1?json({error:'offline'},503):json({ok:true,alreadyCommitted:true});
    }
    assert.fail(route);
  }});
  assert.equal(starts,1);assert.equal(claims,2);
  assert.equal(f.events.lastIndexOf('/api/worker/receipt')<f.events.lastIndexOf('/api/worker/turns/completed-native-turn/fail'),true);
});

test('Ctrl+C during a native turn closes its writer before preserving the partial original',async t=>{
  const f=await fixture(t);let starts=0,closes=0,interrupts=0;
  class FakeRpc extends EventEmitter{
    async initialize(){return {userAgent:'fake-runtime'};}
    async close(){
      if(this.closed)return;this.closed=true;
      if(this.file){closes++;await writeFile(this.file,original+message('user','Interrupted instruction')+message('assistant','Saved while closing writer.'));}
    }
    async request(method,params){
      if(method==='account/read')return {account:{type:'chatgpt',email:'test@example.com',planType:'plus'}};
      if(method==='thread/resume'){this.file=params.path;return {thread:{id:nativeId,path:this.file,historyMode:'legacy'}};}
      if(method==='turn/interrupt'){interrupts++;return {};}
      if(method==='turn/start'){
        starts++;this.emit('notification',{method:'turn/started',params:{threadId:nativeId,turn:{id:'native-interrupted'}}});
        queueMicrotask(()=>f.controller.abort());return {turn:{id:'native-interrupted'}};
      }
      assert.fail(method);
    }
  }
  await runAgent({...f,rpcFactory:async()=>new FakeRpc(),fetchImpl:async url=>{
    const route=new URL(url).pathname;
    if(route==='/api/worker/register'||route.endsWith('/applied'))return json({ok:true});
    if(route==='/api/worker/recovery')return json({turns:[]});
    if(route==='/api/worker/claim')return json({job:{id:'interrupted-native-turn',checkpoint:original,nativeId,baseHash:digest(original),baseRevision:1,lease:'lease',authorName:'Tester',authorId:'test',prompt:'Continue'}});
    assert.fail('Aborted HTTP request must not reach the host: '+route);
  }});
  assert.equal(starts,1);assert.equal(closes,1);assert.equal(interrupts,1);
  assert.match(await readFile(path.join(f.dataDir,'checkpoints','interrupted-native-turn.recovery.jsonl'),'utf8'),/Saved while closing writer/);
});
