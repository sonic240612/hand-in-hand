import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { createCodexRuntime } from './codex-runtime.mjs';
import { digest, inspectCheckpoint } from './session.mjs';
import { HOST_TOOLS } from './workspace.mjs';
import { connectHostExec } from './exec-transport.mjs';
import { interactionKind } from './interactions.mjs';
import { saveReceipt, removeReceipt, flushReceipts } from './completion-receipts.mjs';

export const BASE_INSTRUCTIONS = `You are the coding assistant in hand-in-hand, a shared session. Every turn can come from a different participant and use their own account. Continue this SAME native conversation; all preceding user instructions, assistant responses and tool results still apply. Preserve who said what. Later user corrections override earlier user requirements. Respond in Korean unless asked otherwise. Be concise.
All project files are on the shared HOST execution environment. Use the selected host environment for shell commands, file edits, tests, builds, and project images. Native Codex tools, web search, installed MCP tools, plugins, skills, and subagents are available according to this participant's account and installed runtime. Personal connectors use this participant's credentials. Respect approval requests and explain unavailable capabilities accurately. Preserve who said what and do not create a new conversation or a handoff summary in place of this session. Native compaction may manage active context while the original session log is retained. This runtime replaces earlier prototype restrictions that allowed only four host_* tools or prohibited native tools. The old host_* tools remain usable for earlier sessions; read before writing with those tools and pass expectedHash.`;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function identity(account) {
  if (!account) throw new Error('Codex 로그인이 필요합니다. 이 기기에서 codex login 후 다시 연결하세요.');
  if (account.type!=='chatgpt') throw new Error('추가 과금 방지를 위해 ChatGPT 계정 로그인만 지원합니다.');
  const id = account.email || account.chatgptAccountId || account.id;
  const masked = account.email ? account.email.replace(/^(.).+(@.*)$/, '$1***$2') : account.type;
  return { label: `${masked} · ${account.planType || account.type}`, type: account.type,
    fingerprint: id ? digest(`${account.type}:${id}`) : null };
}
export async function runNativeTurn(options) {
  // Loading a participant's plugins can take longer than one model turn.
  // Keep the lease alive during initialization as well as during execution.
  const heartbeat=setInterval(()=>options.api(`/api/worker/turns/${options.job.id}/heartbeat`,{lease:options.job.lease}).catch(()=>{}),2000);
  let runtimeReady=false;
  try{return await nativeTurn({...options,onRuntimeReady:()=>{runtimeReady=true;}});}
  catch(error){
    if(!error.hihReported)try{await options.api(`/api/worker/turns/${options.job.id}/fail`,{lease:options.job.lease,error:error.message,failurePhase:runtimeReady?undefined:'setup_failed'});}catch{}
    throw error;
  }finally{clearInterval(heartbeat);}
}
async function nativeTurn({ job, accountExpected, api, dataDir, signal, executable, rpcFactory=createCodexRuntime,connectExecution,onRuntimeReady }) {
  const scratch = path.join(dataDir, 'empty-workspace');
  const checkpoints = path.join(dataDir, 'checkpoints');
  await mkdir(scratch,{recursive:true}); await mkdir(checkpoints,{recursive:true});
  const rpc = await rpcFactory({cwd:scratch,executable,dataDir,loadUserTools:!!job.execution});
  onRuntimeReady();
  let nativeId, rolloutPath, nativeTurnId, completed, fatal, usage,execution,stage='setup';
  const nativeThreads=new Map();
  let chain = Promise.resolve(), eventDeliveryFailed=false, finalEventBytes=0, finalEventError;
  const finalEvents=new Map();
  // Live UI delivery is not the native checkpoint commit. Once a delivery
  // fails, stop this turn's stream without preventing a confirmed completion
  // from closing its writer and entering the durable receipt outbox.
  const emit = body => {
    if(['message','nativeTool'].includes(body.kind)&&body.item?.id&&!finalEventError){
      const key=body.kind+':'+body.item.id,encoded=JSON.stringify(body),bytes=Buffer.byteLength(encoded);
      const total=finalEventBytes-(finalEvents.get(key)?.bytes||0)+bytes;
      const count=finalEvents.size+(finalEvents.has(key)?0:1);
      if(count>2000||total+count+1>8*1024*1024)finalEventError=new Error('최종 출력 기록 크기 제한을 초과했습니다. 원본 세션 확인이 필요합니다.');
      else{finalEvents.set(key,{encoded,bytes});finalEventBytes=total;}
    }
    chain = chain.then(async()=>{
    if(eventDeliveryFailed)return;
    try{await api(`/api/worker/turns/${job.id}/event`, {lease:job.lease,...body});}
    catch{eventDeliveryFailed=true;}
    });
  };
  let finish;
  const done = new Promise(resolve => { finish=resolve; });
  const interrupt = () => { if (nativeId && nativeTurnId) rpc.request('turn/interrupt',{threadId:nativeId,turnId:nativeTurnId}).catch(()=>{}); };
  const abort = () => { fatal = new Error('실행기 연결을 종료했습니다.'); interrupt(); finish(); };
  signal?.addEventListener('abort',abort,{once:true});
  rpc.on('closed',()=>{if(!completed){fatal ||= new Error('Codex가 턴 완료 전에 종료되었습니다.');finish();}});
  rpc.on('notification',msg=>{
    const p=msg.params || {};
    if(msg.method==='thread/started'&&p.thread?.id)nativeThreads.set(p.thread.id,p.thread.path||null);
    if(p.threadId && nativeId && p.threadId!==nativeId) return;
    if(msg.method==='turn/started') nativeTurnId=p.turn?.id;
    if(msg.method==='item/agentMessage/delta') emit({kind:'delta',itemId:p.itemId,delta:p.delta});
    if(msg.method==='item/commandExecution/outputDelta')emit({kind:'toolDelta',itemId:p.itemId,delta:p.delta});
    if(msg.method==='turn/plan/updated')emit({kind:'nativeTool',phase:'completed',item:{id:'plan-'+job.id,type:'plan',status:'completed',plan:p.plan,explanation:p.explanation}});
    if(msg.method==='item/completed' && p.item?.type==='agentMessage') emit({kind:'message',item:p.item});
    if(['item/started','item/completed'].includes(msg.method) && p.item && !['agentMessage','userMessage','reasoning','contextCompaction'].includes(p.item.type))emit({kind:'nativeTool',phase:msg.method==='item/started'?'started':'completed',item:p.item});
    if(['item/started','item/completed'].includes(msg.method) && p.item?.type==='contextCompaction') emit({kind:'compaction',status:msg.method==='item/started'?'started':'completed'});
    if(msg.method==='thread/tokenUsage/updated') usage=p.tokenUsage;
    if(msg.method==='turn/completed') {completed=p.turn;finish();}
  });
  rpc.on('request',async msg=>{
    if(msg.method==='account/chatgptAuthTokens/refresh') return;
    try {
      if(msg.method==='currentTime/read'){rpc.send({id:msg.id,result:{currentTimeAt:Math.floor(Date.now()/1000)}});return;}
      if(msg.method!=='item/tool/call') {
        interactionKind(msg.method);
        const {id}=await api(`/api/worker/turns/${job.id}/interaction/open`,{lease:job.lease,requestId:msg.id,method:msg.method,params:msg.params});
        while(!rpc.closed&&!signal?.aborted&&!completed) {
          const result=await api(`/api/worker/turns/${job.id}/interaction/poll`,{lease:job.lease,id});
          if(result.ready){rpc.send({id:msg.id,result:result.result});return;}
          await delay(600);
        }
        return;
      }
      const p=msg.params;
      const result=await api(`/api/worker/turns/${job.id}/tool`,{lease:job.lease,callId:p.callId,name:p.tool,args:p.arguments});
      rpc.send({id:msg.id,result:{success:result.success,contentItems:[{type:'inputText',text:JSON.stringify(result.output)}]}});
    } catch(error) {
      try {rpc.send(msg.method==='item/tool/call'?{id:msg.id,result:{success:false,contentItems:[{type:'inputText',text:error.message}]}}:{id:msg.id,error:{code:-32601,message:error.message}});}catch{}
    }
  });
  let heartbeat, timeout;
  try {
    await rpc.initialize();
    signal?.throwIfAborted();
    const auth=identity((await rpc.request('account/read',{refreshToken:false})).account);
    if (JSON.stringify(auth)!==JSON.stringify(accountExpected)) throw new Error('연결 후 Codex 인증 계정이 변경되었습니다. 다시 연결하세요.');
    if(job.execution) {
      if(!connectExecution)throw new Error('호스트 도구 연결을 지원하는 실행기가 필요합니다.');
      execution=await connectExecution(job);
      await rpc.request('environment/add',{environmentId:job.execution.environmentId,execServerUrl:execution.url});
      await rpc.request('environment/info',{environmentId:job.execution.environmentId});
    }
    const environments=job.execution?[{...job.execution,runtimeWorkspaceRoots:[job.execution.cwd]}]:[];
    const common={cwd:scratch,approvalPolicy:job.execution?'on-request':'never',sandbox:job.execution?'workspace-write':'read-only',...(job.execution?{baseInstructions:BASE_INSTRUCTIONS,developerInstructions:'Project commands and edits must use the shared host execution environment. Earlier prototype tool restrictions are superseded.'}:{})};
    let response;
    stage='resume';
    if(job.checkpoint) {
      const info=inspectCheckpoint(job.checkpoint,job.nativeId);
      if(info.hash!==job.baseHash) throw new Error('받은 세션 원본의 hash가 일치하지 않습니다.');
      const imported=path.join(checkpoints,`${job.id}.jsonl`);
      await writeFile(imported,job.checkpoint,{mode:0o600});
      for(const [id,raw] of Object.entries(job.nativeThreads||{})) {
        if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('Invalid child session ID.');
        inspectCheckpoint(raw,id);
        const childPath=path.join(checkpoints,`${job.id}-child-${id}.jsonl`);await writeFile(childPath,raw,{mode:0o600});
        const child=await rpc.request('thread/resume',{...common,threadId:id,path:childPath});
        if(child.thread.id!==id)throw new Error('Child native session ID changed.');nativeThreads.set(id,child.thread.path||childPath);
      }
      response=await rpc.request('thread/resume',{...common,threadId:job.nativeId,path:imported});
      if(response.thread.id!==job.nativeId) throw new Error('Codex가 다른 세션 ID를 반환했습니다.');
      const loaded=await readFile(imported,'utf8');
      if(!loaded.startsWith(job.checkpoint)) throw new Error('복원 중 세션 원본이 변경되었습니다.');
    } else {
      response=await rpc.request('thread/start',{...common,historyMode:'legacy',environments,
        serviceName:'hand-in-hand',baseInstructions:BASE_INSTRUCTIONS,dynamicTools:HOST_TOOLS});
    }
    nativeId=response.thread.id; rolloutPath=response.thread.path;
    if(response.thread.historyMode && response.thread.historyMode!=='legacy') throw new Error('이 Codex 버전은 지정한 세션 저장 형식을 지원하지 않습니다.');
    if(!rolloutPath) throw new Error('Codex 세션 저장 경로를 확인할 수 없습니다.');
    await api(`/api/worker/turns/${job.id}/applied`,{lease:job.lease,nativeId,hash:job.baseHash,revision:job.baseRevision,model:response.model});
    heartbeat=setInterval(()=>api(`/api/worker/turns/${job.id}/heartbeat`,{lease:job.lease}).then(r=>{if(r.cancel) interrupt();}).catch(()=>{fatal ||= new Error('호스트 연결이 끊겼습니다.');interrupt();finish();}),2000);
    if(job.execution) {
      const [mcp,skills]=await Promise.all([
        rpc.request('mcpServerStatus/list',{detail:'toolsAndAuthOnly',limit:100},5000).catch(()=>null),
        rpc.request('skills/list',{cwds:[scratch]},5000).catch(()=>null),
      ]);
      emit({kind:'capabilities',catalog:{native:true,mcpTools:mcp?mcp.data.reduce((n,s)=>n+Object.keys(s.tools||{}).length,0):null,skills:skills?skills.data.reduce((n,s)=>n+(s.skills?.length||0),0):null}});
    }
    timeout=setTimeout(()=>{fatal=new Error('실행 시간 제한(30분)에 도달했습니다.');interrupt();finish();},1_800_000);
    const text=`[hand-in-hand participant: ${job.authorName}; participant_id: ${job.authorId}]\n${job.prompt}`;
    signal?.throwIfAborted();
    const started=await rpc.request('turn/start',{threadId:nativeId,input:[{type:'text',text}],environments,effort:'low'});
    nativeTurnId=started.turn.id;
    await done;
    if(fatal&&!completed) throw fatal;
    await chain;
    for(const [id,file] of nativeThreads)if(id!==nativeId&&!file) {
      const child=await rpc.request('thread/read',{threadId:id,includeTurns:false});
      if(!child.thread.path)throw new Error('하위 에이전트의 세션 저장 경로를 확인할 수 없습니다.');
      nativeThreads.set(id,child.thread.path);
    }
    await rpc.close();
    await execution?.close();
    const checkpoint=await readFile(rolloutPath,'utf8');
    inspectCheckpoint(checkpoint,nativeId,job.checkpoint);
    const children={};
    for(const [id,file] of nativeThreads)if(id!==nativeId) {
      const relative=path.relative(path.resolve(dataDir),path.resolve(file));
      if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Child checkpoint is outside this runner.');
      const raw=await readFile(file,'utf8');inspectCheckpoint(raw,id,job.nativeThreads?.[id]||'');children[id]=raw;
    }
    if(finalEventError)throw finalEventError;
    const payload={lease:job.lease,nativeId,checkpoint,status:completed.status,error:completed.error?.message||null,model:response.model,usage,nativeThreads:children,
      finalEvents:[...finalEvents.values()].map(event=>JSON.parse(event.encoded))};
    await saveReceipt(dataDir,job.id,payload);
    await api(`/api/worker/turns/${job.id}/complete`,payload);
    await removeReceipt(dataDir,job.id);
  } catch(error) {
    error.hihReported=true;
    await Promise.allSettled([rpc.close(),execution?.close()]);
    // Preserve a recoverable partial native log locally; never silently restart with old history.
    if(rolloutPath) {try {await writeFile(path.join(checkpoints,`${job.id}.recovery.jsonl`),await readFile(rolloutPath),{mode:0o600});}catch{}}
    const failurePhase=stage==='setup'?'setup_failed':!nativeId && error.rpcMethod==='thread/resume' && error.code===-32600 ? 'resume_rejected' : undefined;
    try {await api(`/api/worker/turns/${job.id}/fail`,{lease:job.lease,error:error.message,failurePhase});}catch{}
    throw error;
  } finally {
    clearInterval(heartbeat);clearTimeout(timeout);signal?.removeEventListener('abort',abort);
    await Promise.allSettled([rpc.close(),execution?.close()]);
  }
}

export async function runAgent({ host, pair, dataDir=path.resolve('.hih-agent'), signal, executable, log=console.log, onReady }={}) {
  host=new URL(host).origin;
  await mkdir(dataDir,{recursive:true});
  let token;
  async function api(route,body) {
    const response=await fetch(host+route,{method:body===undefined?'GET':'POST',headers:{...(token?{Authorization:`Bearer ${token}`} : {}),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(35_000)});
    const result=await response.json();
    if(!response.ok) throw Object.assign(new Error(result.error || `Host HTTP ${response.status}`),{status:response.status});
    return result;
  }
  if(pair) {
    const joined=await api('/api/agent/pair',{code:pair}); token=joined.token;
    await writeFile(path.join(dataDir,'connection.json'),JSON.stringify({host,token}),{mode:0o600});
  } else {
    const saved=JSON.parse(await readFile(path.join(dataDir,'connection.json'),'utf8'));
    if(saved.host!==host) throw new Error('저장된 연결의 호스트가 다릅니다. 새 연결 코드를 사용하세요.');
    token=saved.token;
  }
  await flushReceipts(dataDir,api,log);
  const scratch=path.join(dataDir,'empty-workspace');await mkdir(scratch,{recursive:true});
  const probe=await createCodexRuntime({cwd:scratch,executable,dataDir});
  let account,runtime;
  try {
    runtime=await probe.initialize();
    account=identity((await probe.request('account/read',{refreshToken:false})).account);
  } finally {await probe.close();}
  const runnerId=randomUUID();
  const register=()=>api('/api/worker/register',{runnerId,protocolVersion:3,features:['completion-receipts'],account:account.label,accountType:account.type,accountFingerprint:account.fingerprint,runtime:runtime.userAgent,device:os.hostname()});
  const recover=async()=>{
    const {turns}=await api('/api/worker/recovery');
    for(const turn of turns) {
      // IDs originate from this authenticated participant's host queue, not a supplied file path.
      if(!/^[0-9a-f-]{36}$/.test(turn.id)) throw new Error('Invalid recovery turn ID.');
      let checkpoint;
      try {checkpoint=await readFile(path.join(dataDir,'checkpoints',`${turn.id}.recovery.jsonl`),'utf8');}
      catch(error){if(error.code==='ENOENT'){log('이 기기에 압축 중단 복구 파일이 없습니다. 오류가 발생한 기기와 데이터 폴더에서 다시 연결하세요.');continue;}throw error;}
      await api('/api/worker/recovery',{turnId:turn.id,checkpoint});
      log('중단된 세션 원본을 호스트에 복구했습니다. 브라우저의 다시 실행을 누르세요.');
    }
  };
  await register();await recover();
  log(`Codex 연결 완료: ${account.label}. 같은 세션의 내 차례를 기다립니다.`);
  onReady?.({account});
  while(!signal?.aborted) {
    try {
      await flushReceipts(dataDir,api,log);
      const {job}=await api('/api/worker/claim',{runnerId});
      if(job) {
        log(`세션 v${job.baseRevision} → 내 턴 실행`);
        await runNativeTurn({job,accountExpected:account,api,dataDir,signal,executable,connectExecution:job=>connectHostExec({host,token,job,signal})});
        log('동일 세션에 턴 저장 완료');
      } else await delay(800);
    } catch(error) {
      if(signal?.aborted) break;
      log(`실행기: ${error.message}`);
      if(error.status===409) {try{await register();await recover();}catch(reconnectError){log(`재연결: ${reconnectError.message}`);}}
      await delay(2500);
    }
  }
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),get=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
  const host=get('--host','http://127.0.0.1:4317');
  let pair=get('--pair');
  if(!pair && !args.includes('--resume')) {const rl=createInterface({input:process.stdin,output:process.stdout});pair=await rl.question('화면에 표시된 내 Codex 연결 코드: ');rl.close();}
  const controller=new AbortController();process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
  runAgent({host,pair,dataDir:path.resolve(get('--data','.hih-agent')),signal:controller.signal}).catch(error=>{console.error(error.message);process.exitCode=1;});
}
