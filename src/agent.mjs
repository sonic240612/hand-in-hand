import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { CodexRpc } from './codex-rpc.mjs';
import { digest, inspectCheckpoint } from './session.mjs';
import { HOST_TOOLS } from './workspace.mjs';

export const BASE_INSTRUCTIONS = `You are the coding assistant in hand-in-hand, a shared session. Every turn can come from a different participant and use their own account. Continue this SAME native conversation; all preceding user instructions, assistant responses and tool results still apply. Preserve who said what. Later user corrections override earlier user requirements. Respond in Korean unless asked otherwise. Be concise.
All project files are on the HOST, accessible ONLY through host_list_files, host_read_file, host_write_file and host_validate_file. Your local execution environment is disabled. Never use local shell, local files, external connectors, subagents, or web search. Read existing host files before writing, pass the returned expectedHash, and validate changed files where possible. Do not claim that a check is stronger than what its result states. Do not summarize or replace the preceding session history. Do not invoke compaction. If a capability is unavailable, say so.`;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function identity(account) {
  if (!account) throw new Error('Codex 로그인이 필요합니다. 이 기기에서 codex login 후 다시 연결하세요.');
  const id = account.email || account.chatgptAccountId || account.id;
  const masked = account.email ? account.email.replace(/^(.).+(@.*)$/, '$1***$2') : account.type;
  return { label: `${masked} · ${account.planType || account.type}`, type: account.type,
    fingerprint: id ? digest(`${account.type}:${id}`) : null };
}
export async function runNativeTurn({ job, accountExpected, api, dataDir, signal, executable }) {
  const scratch = path.join(dataDir, 'empty-workspace');
  const checkpoints = path.join(dataDir, 'checkpoints');
  await mkdir(scratch,{recursive:true}); await mkdir(checkpoints,{recursive:true});
  const rpc = new CodexRpc({cwd:scratch,executable});
  let nativeId, rolloutPath, nativeTurnId, completed, fatal, usage;
  let chain = Promise.resolve();
  const emit = body => { chain = chain.then(()=>api(`/api/worker/turns/${job.id}/event`, {lease:job.lease,...body})); chain.catch(()=>{}); };
  let finish;
  const done = new Promise(resolve => { finish=resolve; });
  const interrupt = () => { if (nativeId && nativeTurnId) rpc.request('turn/interrupt',{threadId:nativeId,turnId:nativeTurnId}).catch(()=>{}); };
  const abort = () => { fatal = new Error('실행기 연결을 종료했습니다.'); interrupt(); finish(); };
  signal?.addEventListener('abort',abort,{once:true});
  rpc.on('closed',()=>{if(!completed){fatal ||= new Error('Codex가 턴 완료 전에 종료되었습니다.');finish();}});
  rpc.on('notification',msg=>{
    const p=msg.params || {};
    if(p.threadId && nativeId && p.threadId!==nativeId) return;
    if(msg.method==='turn/started') nativeTurnId=p.turn?.id;
    if(msg.method==='item/agentMessage/delta') emit({kind:'delta',itemId:p.itemId,delta:p.delta});
    if(msg.method==='item/completed' && p.item?.type==='agentMessage') emit({kind:'message',item:p.item});
    if(msg.method==='item/started' && p.item?.type==='contextCompaction') {fatal=new Error('세션 압축이 감지되어 동일 기록 검증을 중지했습니다.');interrupt();}
    if(msg.method==='thread/tokenUsage/updated') usage=p.tokenUsage;
    if(msg.method==='turn/completed') {completed=p.turn;finish();}
  });
  rpc.on('request',async msg=>{
    try {
      if(msg.method!=='item/tool/call') { rpc.send({id:msg.id,error:{code:-32601,message:'Only shared host tools are supported. No local approvals or tools.'}}); return; }
      const p=msg.params;
      const result=await api(`/api/worker/turns/${job.id}/tool`,{lease:job.lease,callId:p.callId,name:p.tool,args:p.arguments});
      rpc.send({id:msg.id,result:{success:result.success,contentItems:[{type:'inputText',text:JSON.stringify(result.output)}]}});
    } catch(error) {
      try { rpc.send({id:msg.id,result:{success:false,contentItems:[{type:'inputText',text:error.message}]}}); } catch {}
    }
  });
  let heartbeat, timeout;
  try {
    await rpc.initialize();
    const auth=identity((await rpc.request('account/read',{refreshToken:false})).account);
    if (JSON.stringify(auth)!==JSON.stringify(accountExpected)) throw new Error('연결 후 Codex 인증 계정이 변경되었습니다. 다시 연결하세요.');
    const common={cwd:scratch,approvalPolicy:'never',sandbox:'read-only'};
    let response;
    if(job.checkpoint) {
      const info=inspectCheckpoint(job.checkpoint,job.nativeId);
      if(info.hash!==job.baseHash) throw new Error('받은 세션 원본의 hash가 일치하지 않습니다.');
      const imported=path.join(checkpoints,`${job.id}.jsonl`);
      await writeFile(imported,job.checkpoint,{mode:0o600});
      response=await rpc.request('thread/resume',{...common,threadId:job.nativeId,path:imported});
      if(response.thread.id!==job.nativeId) throw new Error('Codex가 다른 세션 ID를 반환했습니다.');
      const loaded=await readFile(imported,'utf8');
      if(!loaded.startsWith(job.checkpoint)) throw new Error('복원 중 세션 원본이 변경되었습니다.');
    } else {
      response=await rpc.request('thread/start',{...common,historyMode:'legacy',environments:[],
        serviceName:'hand-in-hand',baseInstructions:BASE_INSTRUCTIONS,dynamicTools:HOST_TOOLS});
    }
    nativeId=response.thread.id; rolloutPath=response.thread.path;
    if(response.thread.historyMode && response.thread.historyMode!=='legacy') throw new Error('이 Codex 버전은 지정한 세션 저장 형식을 지원하지 않습니다.');
    if(!rolloutPath) throw new Error('Codex 세션 저장 경로를 확인할 수 없습니다.');
    await api(`/api/worker/turns/${job.id}/applied`,{lease:job.lease,nativeId,hash:job.baseHash,revision:job.baseRevision,model:response.model});
    heartbeat=setInterval(()=>api(`/api/worker/turns/${job.id}/heartbeat`,{lease:job.lease}).then(r=>{if(r.cancel) interrupt();}).catch(()=>{fatal ||= new Error('호스트 연결이 끊겼습니다.');interrupt();finish();}),2000);
    timeout=setTimeout(()=>{fatal=new Error('실행 시간 제한(5분)에 도달했습니다.');interrupt();finish();},300_000);
    const text=`[hand-in-hand participant: ${job.authorName}; participant_id: ${job.authorId}]\n${job.prompt}`;
    const started=await rpc.request('turn/start',{threadId:nativeId,input:[{type:'text',text}],environments:[],effort:'low'});
    nativeTurnId=started.turn.id;
    await done;
    if(fatal) throw fatal;
    await chain;
    await rpc.close();
    const checkpoint=await readFile(rolloutPath,'utf8');
    inspectCheckpoint(checkpoint,nativeId,job.checkpoint);
    await api(`/api/worker/turns/${job.id}/complete`,{lease:job.lease,nativeId,checkpoint,
      status:completed.status,error:completed.error?.message || null,model:response.model,usage});
  } catch(error) {
    await rpc.close();
    // Preserve a recoverable partial native log locally; never silently restart with old history.
    if(rolloutPath) {try {await writeFile(path.join(checkpoints,`${job.id}.recovery.jsonl`),await readFile(rolloutPath),{mode:0o600});}catch{}}
    try {await api(`/api/worker/turns/${job.id}/fail`,{lease:job.lease,error:error.message});}catch{}
    throw error;
  } finally {
    clearInterval(heartbeat);clearTimeout(timeout);signal?.removeEventListener('abort',abort);
    await rpc.close();
  }
}

export async function runAgent({ host, pair, dataDir=path.resolve('.hih-agent'), signal, executable, log=console.log, onReady }={}) {
  host=new URL(host).origin;
  await mkdir(dataDir,{recursive:true});
  let token;
  async function api(route,body) {
    const response=await fetch(host+route,{method:body===undefined?'GET':'POST',headers:{...(token?{Authorization:`Bearer ${token}`} : {}),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(35_000)});
    const result=await response.json();
    if(!response.ok) throw new Error(result.error || `Host HTTP ${response.status}`);
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
  const scratch=path.join(dataDir,'empty-workspace');await mkdir(scratch,{recursive:true});
  const probe=new CodexRpc({cwd:scratch,executable});
  let account,runtime;
  try {
    runtime=await probe.initialize();
    account=identity((await probe.request('account/read',{refreshToken:false})).account);
  } finally {await probe.close();}
  const runnerId=randomUUID();
  await api('/api/worker/register',{runnerId,account:account.label,accountType:account.type,accountFingerprint:account.fingerprint,runtime:runtime.userAgent,device:os.hostname()});
  log(`Codex 연결 완료: ${account.label}. 같은 세션의 내 차례를 기다립니다.`);
  onReady?.({account});
  while(!signal?.aborted) {
    try {
      const {job}=await api('/api/worker/claim',{runnerId});
      if(job) {
        log(`세션 v${job.baseRevision} → 내 턴 실행`);
        await runNativeTurn({job,accountExpected:account,api,dataDir,signal,executable});
        log('동일 세션에 턴 저장 완료');
      } else await delay(800);
    } catch(error) {
      if(signal?.aborted) break;
      log(`실행기: ${error.message}`);
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
