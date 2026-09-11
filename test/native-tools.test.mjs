import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import WebSocket from 'ws';
import {createHost} from '../src/server.mjs';
import {createRelay} from '../src/relay.mjs';
import {connectHostExec} from '../src/exec-transport.mjs';
import {Interactions,interactionResult} from '../src/interactions.mjs';
import {toolConfiguration} from '../src/codex-runtime.mjs';
import {tomlValue} from '../src/codex-rpc.mjs';
import {SessionStore,digest} from '../src/session.mjs';
import {nativeId,original,message,line} from './fixtures/native-session.mjs';

async function fixture(t,{withRelay=false}={}) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'hih-native-')),workspace=path.join(dir,'project');await mkdir(workspace);
  let launches=0,closed=0;
  const execFactory=async options=>{
    launches++;assert.equal(options.workspace,workspace);let stream,sequence=0,ended=false;
    return {attach(res){if(stream)throw new Error('Already attached');stream=res;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(': connected\n\n');},
      async send(p){if(p.sequence!==sequence+1)throw new Error('Invalid sequence');sequence++;stream.write('data: '+JSON.stringify({data:p.data,binary:p.binary})+'\n\n');},
      async close(){if(!ended){ended=true;closed++;stream?.end();}}};
  };
  const key=randomBytes(32).toString('base64url'),relay=withRelay?await createRelay({port:0,key,pollMs:100}):null;
  const host=await createHost({port:0,dataDir:path.join(dir,'state'),workspace,allowLocalAgent:false,execFactory,relay:relay?{url:relay.url,key}:undefined});
  t.after(async()=>{await host.close();await relay?.close();await rm(dir,{recursive:true,force:true});});
  const call=async(route,p,token)=>{const r=await fetch(host.url+route,{method:p===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:p===undefined?undefined:JSON.stringify(p)});return {status:r.status,data:await r.json()};};
  const owner=(await call('/api/bootstrap',{})).data,invite=(await call('/api/invites',{},owner.token)).data,b=(await call('/api/join',{name:'B',code:invite.code})).data;
  const pairing=(await call('/api/pairing',{},b.token)).data,agent=(await call('/api/agent/pair',{code:pairing.code})).data;
  await call('/api/worker/register',{protocolVersion:3,runnerId:'runner-b',account:'B account'},agent.token);
  await call('/api/turns',{prompt:'Use native tools',requestId:'b1'},b.token);
  const {job}=(await call('/api/worker/claim',{runnerId:'runner-b'},agent.token)).data;
  if(relay)for(let i=0;i<100;i++){if((await call('/api/state',undefined,owner.token)).data.remoteAccess.connected)break;await new Promise(resolve=>setTimeout(resolve,20));}
  return {host,relay,call,owner,b,agent,job,dir,counts:()=>({launches,closed})};
}

test('tool configuration enables native tools while inheriting MCP and excluding billing and shared databases',()=>{
  const source={model:'unrelated',model_provider:'paid-api',forced_login_method:'api',sqlite_home:'desktop',permissions:'danger',features:{shell_tool:false,multi_agent:false},mcp_servers:{docs:{command:'node',args:['tool.mjs'],env:{LOCAL_SECRET:'test-only'}}},plugins:{example:{enabled:true}}};
  const result=toolConfiguration(source);
  assert.equal(result.features.shell_tool,true);assert.equal(result.features.unified_exec,true);assert.equal(result.features.multi_agent,true);assert.equal(result.web_search,'live');
  assert.deepEqual(result.mcp_servers,source.mcp_servers);assert.deepEqual(result.plugins,source.plugins);
  for(const key of ['model','model_provider','forced_login_method','sqlite_home','permissions'])assert.equal(result[key],undefined);
  assert.equal(source.features.shell_tool,false);
  assert.equal(tomlValue({args:['a','b'],enabled:true,absent:null}),'{ "args" = ["a", "b"], "enabled" = true }');
  assert.equal(tomlValue('C:\\tools\\tool.mjs'),'"C:\\\\tools\\\\tool.mjs"');
});

test('exec transport authenticates and checks the current lease before starting a host process',async t=>{
  const {call,agent,job,owner,counts}=await fixture(t),route=`/api/worker/turns/${job.id}/exec/open`;
  assert.equal((await call(route,{lease:job.lease})).status,401);
  assert.equal((await call(route,{lease:job.lease},owner.token)).status,401);
  assert.equal((await call(route,{lease:'wrong'},agent.token)).status,400);
  assert.equal(counts().launches,0);
  assert.equal((await call(route,{lease:job.lease},agent.token)).status,200);
  assert.equal((await call(route,{lease:job.lease},agent.token)).status,200);
  assert.equal(counts().launches,1);
  await call(`/api/worker/turns/${job.id}/fail`,{lease:job.lease,error:'test ended'},agent.token);
  assert.equal(counts().closed,1);
  assert.equal((await call(route,{lease:job.lease},agent.token)).status,400);
});

for(const withRelay of [false,true])test(`native text and binary frames survive ${withRelay?'the reverse relay':'direct HTTP'} without exposing bearer tokens`,async t=>{
  const {host,relay,job,agent,counts}=await fixture(t,{withRelay}),bridge=await connectHostExec({host:relay?.url||host.url,token:agent.token,job});t.after(()=>bridge.close());
  assert.ok(!bridge.url.includes(agent.token));assert.equal(new URL(bridge.url).hostname,'127.0.0.1');
  const wrong=new WebSocket(new URL('/wrong',bridge.url));wrong.on('error',()=>{});await new Promise(resolve=>wrong.once('close',resolve));
  const client=new WebSocket(bridge.url);client.on('error',()=>{});await once(client,'open');
  // The stream is attached before a native exec request can return a response.
  await new Promise(resolve=>setTimeout(resolve,30));
  for(const [data,binary] of [['{"id":1,"method":"test"}',false],[Buffer.from([0,1,255,17]),true]]){
    const received=once(client,'message');client.send(data,{binary});const [echo,kind]=await received;
    assert.equal(kind,binary);assert.deepEqual(echo,Buffer.from(data));
  }
  client.close();await bridge.close();assert.deepEqual(counts(),{launches:1,closed:1});
});

test('initial tool setup failure is retryable only before a native session was applied',async t=>{
  for(const applied of [false,true]){
    const {host,call,job,agent}=await fixture(t);
    if(applied)await call(`/api/worker/turns/${job.id}/applied`,{lease:job.lease,nativeId,hash:job.baseHash,revision:job.baseRevision},agent.token);
    await call(`/api/worker/turns/${job.id}/fail`,{lease:job.lease,error:'exec-server unavailable',failurePhase:'setup_failed'},agent.token);
    assert.equal(host.store.state.turns[0].retryable,!applied?true:undefined);
    assert.equal(!!host.store.state.blocked,applied);
    assert.equal(host.store.state.revision,0);
  }
});

test('native tool events are recorded with their execution location and replace streaming item states',async t=>{
  const {host,call,job,agent}=await fixture(t),route=`/api/worker/turns/${job.id}/event`;
  const item={id:'exec-1',type:'commandExecution',command:'node --version',status:'inProgress'};
  await call(route,{lease:job.lease,kind:'nativeTool',phase:'started',item},agent.token);
  await call(route,{lease:job.lease,kind:'nativeTool',phase:'completed',item:{...item,status:'completed',aggregatedOutput:'v24'}},agent.token);
  const tools=host.store.active.tools;assert.equal(tools.length,1);assert.equal(tools[0].location,'host');assert.equal(tools[0].result.output.aggregatedOutput,'v24');
  await call(route,{lease:job.lease,kind:'nativeTool',phase:'completed',item:{id:'mcp-1',type:'mcpToolCall',server:'docs',status:'completed'}},agent.token);
  assert.equal(tools[1].location,'account');
});

test('command and permission approvals belong to the host; questions and MCP confirmations belong to the author',async t=>{
  const {host,call,job,agent,owner,b}=await fixture(t),base=`/api/worker/turns/${job.id}/interaction`;
  const cases=[
    ['item/commandExecution/requestApproval',{command:'node --version',availableDecisions:['accept','cancel']},owner,b,{action:'accept'},{decision:'accept'}],
    ['item/permissions/requestApproval',{permissions:{network:{enabled:true}}},owner,b,{action:'decline'},{permissions:{},scope:'turn'}],
    ['item/tool/requestUserInput',{questions:[{id:'q1',question:'Which output?'}]},b,owner,{answers:{q1:['JSON']}},{answers:{q1:{answers:['JSON']}}}],
    ['mcpServer/elicitation/request',{mode:'form',requestedSchema:{properties:{name:{type:'string'}}}},b,owner,{action:'accept',content:{name:'example'}},{action:'accept',content:{name:'example'}}],
  ];
  for(const [index,[method,params,actor,other,reply,result]] of cases.entries()){
    const opened=await call(base+'/open',{lease:job.lease,requestId:index,method,params},agent.token);assert.equal(opened.status,200);const id=opened.data.id;
    assert.equal((await call('/api/interactions/'+id,undefined,other.token)).status,403);
    assert.equal((await call('/api/interactions/'+id,reply,other.token)).status,403);
    assert.equal((await call('/api/interactions/'+id,reply,actor.token)).status,200);
    assert.deepEqual((await call(base+'/poll',{lease:job.lease,id},agent.token)).data,{ready:true,result});
    assert.equal((await call('/api/interactions/'+id,reply,actor.token)).status,400);
    const publicEntry=host.store.publicState().turns[0].interactions.find(p=>p.id===id);assert.equal(publicEntry.params,undefined);assert.equal(publicEntry.result,undefined);
  }
});

test('pending questions cannot be answered after their turn ends and cannot impersonate auth requests',()=>{
  let saves=0;const store=new Interactions({ownerId:()=> 'owner',save:()=>saves++}),turn={id:'turn',authorId:'b'};
  const opened=store.open(turn,{requestId:1,method:'item/tool/requestUserInput',params:{questions:[{id:'q1'}]}});
  assert.deepEqual(store.open(turn,{requestId:1,method:'item/tool/requestUserInput'}),opened);
  assert.throws(()=>store.open(turn,{requestId:2,method:'account/chatgptAuthTokens/refresh'}),/지원하지 않는/);
  assert.throws(()=>store.reply(turn,opened.id,'b',{answers:{}}),/답변/);
  store.finish(turn);assert.equal(turn.interactions[0].status,'cancelled');assert.throws(()=>store.reply(turn,opened.id,'b',{answers:{q1:['yes']}}));
  assert.equal(saves,1);
  assert.deepEqual(interactionResult('item/commandExecution/requestApproval',{availableDecisions:['accept','cancel']},{action:'decline'}),{decision:'cancel'});
});

test('child native histories retain their exact prefix and are not mixed with the parent checkpoint',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'hih-children-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=new SessionStore(dir),childId='22222222-2222-4222-8222-222222222222';
  Object.assign(store.state,{nativeId,checkpoint:original,checkpointHash:digest(original),revision:1});store.save();
  const child=line({type:'session_meta',payload:{id:childId}})+message('user','Remember the child note.');
  const turn=store.enqueue({id:'a',name:'A'},'Use an agent','a1');store.claim('a','ra','A','a');
  store.complete(turn,{nativeId,checkpoint:original+message('user',turn.prompt),nativeThreads:{[childId]:child},status:'completed'});
  assert.equal(store.publicState().nativeThreadCount,1);assert.equal(store.publicState().nativeThreads,undefined);
  const next=store.enqueue({id:'b',name:'B'},'Ask the same child','b1');store.claim('b','rb','B','b');
  const checkpoint=store.state.checkpoint+message('user',next.prompt);
  assert.throws(()=>store.complete(next,{nativeId,checkpoint,status:'completed',nativeThreads:{[childId]:child.replace('child note','changed note')}}),/rewritten/);
  assert.equal(store.state.revision,2);
  const continued=child+message('assistant','Still here.');store.complete(next,{nativeId,checkpoint,status:'completed',nativeThreads:{[childId]:continued}});
  assert.equal(store.state.nativeThreads[childId],continued);
});
