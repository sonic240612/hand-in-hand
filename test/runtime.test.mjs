import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { CodexRpc } from '../src/codex-rpc.mjs';
import { runtimeEnvironment, readChatgptTokens } from '../src/codex-runtime.mjs';
import { runNativeTurn } from '../src/agent.mjs';
import { digest } from '../src/session.mjs';
import {nativeId,original,compact,message,line} from './fixtures/native-session.mjs';

async function fixture(t) {const dir=await mkdtemp(path.join(os.tmpdir(),'hih-runtime-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('isolated runtime removes API credentials and cannot inherit the desktop state location',()=>{
  const original={PATH:'unchanged',CODEX_HOME:'desktop',CODEX_SQLITE_HOME:'desktop-db',OPENAI_API_KEY:'api-key',codex_api_key:'other-api-key',CODEX_ACCESS_TOKEN:'other-token',OPENAI_IDENTITY_TOKEN_FILE:'identity'};
  const env=runtimeEnvironment(original,'isolated');
  assert.deepEqual(env,{PATH:'unchanged',CODEX_HOME:'isolated',CODEX_SQLITE_HOME:'isolated'});
  assert.equal(original.CODEX_HOME,'desktop');
});

test('login bridge accepts only local ChatGPT access tokens and checks the account on refresh',async t=>{
  const dir=await fixture(t),authFile=path.join(dir,'auth.json');
  const login={auth_mode:'chatgpt',tokens:{access_token:'local-access',refresh_token:'never-forward-this',account_id:'account-a'}};
  await writeFile(authFile,JSON.stringify(login));
  assert.deepEqual(await readChatgptTokens(dir),{accessToken:'local-access',chatgptAccountId:'account-a'});
  await assert.rejects(readChatgptTokens(dir,'account-b'),/계정이 변경/);
  for(const invalid of [{auth_mode:'apikey',OPENAI_API_KEY:'private-key'}, {...login,OPENAI_API_KEY:'private-key'}, {auth_mode:'chatgpt'}]) {
    await writeFile(authFile,JSON.stringify(invalid));
    await assert.rejects(readChatgptTokens(dir),error=>/ChatGPT/.test(error.message)&&!error.message.includes('private-key'));
  }
});

test('RPC preserves error phase and close waits until a child ignoring EOF is really dead',async t=>{
  const dir=await fixture(t),script=path.join(dir,'fake-codex.mjs');
  await writeFile(script,`import readline from 'node:readline';
    readline.createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);if(p.id)process.stdout.write(JSON.stringify({id:p.id,error:{code:-32600,message:'writer busy'}})+'\\n');});
    process.stdin.on('end',()=>{});setInterval(()=>{},1000);`);
  const rpc=new CodexRpc({executable:process.execPath,argsPrefix:[script]});t.after(()=>rpc.close());
  await assert.rejects(rpc.request('thread/resume',{}),error=>error.code===-32600&&error.rpcMethod==='thread/resume');
  const closing=rpc.close();assert.equal(rpc.close(),closing);await closing;
  assert.equal(rpc.closed,true);assert.throws(()=>process.kill(rpc.child.pid,0),{code:'ESRCH'});
});

test('runner labels only an explicit resume rejection as safe; a turn-start error remains uncertain',async t=>{
  const dir=await fixture(t),nativeId='11111111-1111-4111-8111-111111111111';
  const checkpoint=JSON.stringify({type:'session_meta',payload:{id:nativeId}})+'\n';
  const account={type:'chatgpt',email:'anna@example.test',planType:'plus'};
  const expected={label:'a***@example.test · plus',type:'chatgpt',fingerprint:digest('chatgpt:anna@example.test')};
  for(const phase of ['thread/resume','turn/start']) {
    const requests=[];
    class FakeRpc extends EventEmitter {
      async initialize() {}
      async close() {}
      async request(method,params) {
        if(method==='account/read')return {account};
        if(method===phase)throw Object.assign(new Error(`thread ${nativeId} already has an active writer (-32600)`),{code:-32600,rpcMethod:method});
        if(method==='thread/resume')return {thread:{id:nativeId,path:params.path,historyMode:'legacy'}};
      }
    }
    await assert.rejects(runNativeTurn({dataDir:dir,job:{id:phase.replace('/','-'),checkpoint,nativeId,baseHash:digest(checkpoint),baseRevision:1,lease:'lease',authorName:'A',authorId:'a',prompt:'Continue'},accountExpected:expected,
      api:async(route,p)=>{requests.push({route,p});return {};},rpcFactory:async()=>new FakeRpc()}),/active writer/);
    const failed=requests.find(r=>r.route.endsWith('/fail'));
    assert.equal(failed.p.failurePhase,phase==='thread/resume'?'resume_rejected':undefined);
    assert.equal(requests.some(r=>r.route.endsWith('/applied')),phase==='turn/start');
  }
});

test('runner persists normal compaction and completion without interrupting the native turn',async t=>{
  const dir=await fixture(t),calls=[],requests=[],prompt='Recall the project.';
  const account={type:'chatgpt',email:'anna@example.test',planType:'plus'};
  class FakeRpc extends EventEmitter {
    async initialize() {}
    async close() {this.closed=true;}
    async request(method,params) {
      requests.push(method);
      if(method==='account/read')return {account};
      if(method==='thread/resume'){this.rollout=params.path;return {thread:{id:nativeId,path:params.path,historyMode:'legacy'},model:'test-model'};}
      if(method==='turn/start') {
        this.emit('notification',{method:'turn/started',params:{threadId:nativeId,turn:{id:'turn-1'}}});
        for(const phase of ['started','completed'])this.emit('notification',{method:`item/${phase}`,params:{threadId:nativeId,item:{id:'compact-1',type:'contextCompaction'}}});
        await writeFile(this.rollout,original+compact()+message('user',params.input[0].text)+message('assistant','Violet.'));
        this.emit('notification',{method:'turn/completed',params:{threadId:nativeId,turn:{id:'turn-1',status:'completed'}}});
        return {turn:{id:'turn-1'}};
      }
      throw new Error('Unexpected RPC: '+method);
    }
  }
  const rpc=new FakeRpc();
  await runNativeTurn({dataDir:dir,job:{id:'compacted-turn',checkpoint:original,nativeId,baseHash:digest(original),baseRevision:1,lease:'lease',authorName:'B',authorId:'b',prompt},
    accountExpected:{label:'a***@example.test · plus',type:'chatgpt',fingerprint:digest('chatgpt:anna@example.test')},rpcFactory:async()=>rpc,
    api:async(route,p)=>{if(route.endsWith('/complete'))assert.equal(rpc.closed,true);calls.push({route,p});return {};}});
  assert.equal(requests.includes('turn/interrupt'),false);
  assert.deepEqual(calls.filter(c=>c.p.kind==='compaction').map(c=>c.p.status),['started','completed']);
  assert.equal(calls.some(c=>c.route.endsWith('/fail')),false);
  const result=calls.find(c=>c.route.endsWith('/complete')).p;
  assert.equal(result.nativeId,nativeId);assert.equal(result.status,'completed');
  assert.ok(result.checkpoint.startsWith(original));assert.ok(result.checkpoint.includes('"type":"compacted"'));
});

test('native runner binds the host environment and exports child history after runtime shutdown',async t=>{
  const dir=await fixture(t),calls=[],methods=[],childId='22222222-2222-4222-8222-222222222222';
  const childOriginal=line({type:'session_meta',payload:{id:childId}})+message('user','Child context');
  const execution={environmentId:'hih-host',cwd:'C:\\SharedProject'};
  let closed=false,bridgeClosed=false,childPath,parentPath;
  class FakeRpc extends EventEmitter {
    async initialize(){}
    async close(){if(closed)return;closed=true;await writeFile(childPath,childOriginal+message('assistant','Child context retained.'));}
    async request(method,params){
      methods.push(method);
      if(method==='account/read')return {account:{type:'chatgpt',email:'anna@example.test',planType:'plus'}};
      if(method==='environment/add'){assert.equal(params.environmentId,execution.environmentId);assert.equal(params.execServerUrl,'ws://127.0.0.1:1234/private-test');return {};}
      if(method==='environment/info')return {};
      if(method==='thread/resume'){
        assert.equal(params.sandbox,'workspace-write');assert.equal(params.approvalPolicy,'on-request');assert.match(params.developerInstructions,/host/);
        if(params.threadId===childId)childPath=params.path;else parentPath=params.path;
        return {thread:{id:params.threadId,path:params.path,historyMode:'legacy'}};
      }
      if(method==='mcpServerStatus/list')return {data:[{tools:{read:{},search:{}}}]};
      if(method==='skills/list')return {data:[{skills:[{name:'sample'}]}]};
      if(method==='thread/read')return {thread:{id:childId,path:childPath}};
      if(method==='turn/start'){
        assert.deepEqual(params.environments,[{...execution,runtimeWorkspaceRoots:[execution.cwd]}]);
        assert.ok(methods.indexOf('environment/add')<methods.indexOf('thread/resume'));
        this.emit('notification',{method:'thread/started',params:{thread:{id:childId,path:null}}});
        await writeFile(parentPath,original+message('user',params.input[0].text));
        this.emit('notification',{method:'turn/completed',params:{threadId:nativeId,turn:{id:'t1',status:'completed'}}});
        return {turn:{id:'t1'}};
      }
      throw new Error('Unexpected method '+method);
    }
  }
  await runNativeTurn({dataDir:dir,job:{id:'native-child-turn',checkpoint:original,nativeId,baseHash:digest(original),baseRevision:1,lease:'lease',authorName:'B',authorId:'b',prompt:'Continue',execution,nativeThreads:{[childId]:childOriginal}},
    accountExpected:{label:'a***@example.test · plus',type:'chatgpt',fingerprint:digest('chatgpt:anna@example.test')},
    rpcFactory:async options=>{assert.equal(options.loadUserTools,true);return new FakeRpc();},
    connectExecution:async()=>({url:'ws://127.0.0.1:1234/private-test',close:async()=>{bridgeClosed=true;}}),
    api:async(route,p)=>{calls.push({route,p});if(route.endsWith('/complete'))assert.ok(closed&&bridgeClosed);return {};}});
  const result=calls.find(c=>c.route.endsWith('/complete')).p;
  assert.ok(result.checkpoint.startsWith(original));assert.ok(result.nativeThreads[childId].startsWith(childOriginal));assert.match(result.nativeThreads[childId],/Child context retained/);
  assert.deepEqual(calls.find(c=>c.p.kind==='capabilities').p.catalog,{native:true,mcpTools:2,skills:1});
});

test('plugin initialization failure is reported before any native session can run',async t=>{
  const dir=await fixture(t),calls=[];
  await assert.rejects(runNativeTurn({dataDir:dir,job:{id:'setup-test',lease:'lease'},rpcFactory:async()=>{throw new Error('Invalid personal MCP config');},
    api:async(route,p)=>{calls.push({route,p});return {};}}),/MCP config/);
  assert.equal(calls.filter(c=>c.route.endsWith('/fail')).length,1);
  assert.equal(calls.find(c=>c.route.endsWith('/fail')).p.failurePhase,'setup_failed');
  assert.equal(calls.some(c=>c.route.endsWith('/applied')),false);
});
