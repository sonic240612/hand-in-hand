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
