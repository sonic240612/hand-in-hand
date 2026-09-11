import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SessionStore, digest, MAX_CHECKPOINT } from './session.mjs';
import { Workspace } from './workspace.mjs';
import { runAgent } from './agent.mjs';
import { connectRelay } from './relay-client.mjs';
import { relayOrigin } from './relay.mjs';
import { TailscaleAccess } from './tailscale.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const token=()=>randomBytes(32).toString('base64url');
const loopback=ip=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(ip);
const same=(a,b)=>typeof a==='string' && typeof b==='string' && a.length===b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const nameOf=value=>{if(typeof value!=='string' || !value.trim() || value.length>30 || /[\x00-\x1f]/.test(value))throw new Error('이름은 1~30자로 입력하세요.');return value.trim();};
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
async function body(req) {
  let length=0;const chunks=[];
  for await(const chunk of req) {length+=chunk.length;if(length>MAX_CHECKPOINT*2)throw new Error('요청이 너무 큽니다.');chunks.push(chunk);}
  return chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};
}
export async function createHost({ port=4317, listen='127.0.0.1', dataDir=path.resolve('.hih'), workspace=path.resolve('workspace'), allowLocalAgent=true, relay, tailscale=false }={}) {
  if(relay&&tailscale)throw new Error('Tailscale과 별도 중계 중 하나만 선택하세요.');
  if(relay){relay={...relay,url:relayOrigin(relay.url)};if(!/^[A-Za-z0-9_-]{43,128}$/.test(relay.key||''))throw new Error('유효한 중계 연결 키가 필요합니다.');}
  await mkdir(dataDir,{recursive:true});await mkdir(workspace,{recursive:true});
  const lockFile=path.join(dataDir,'host.lock');
  function takeLock() {const fd=openSync(lockFile,'wx',0o600);writeFileSync(fd,String(process.pid));closeSync(fd);}
  try {takeLock();}catch(error) {
    if(error.code!=='EEXIST')throw error;
    const pid=Number(readFileSync(lockFile,'utf8'));let alive=true;
    try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
    if(alive)throw new Error('이 데이터 폴더를 사용하는 호스트가 이미 실행 중입니다.');
    unlinkSync(lockFile);takeLock();
  }
  const store=new SessionStore(dataDir),files=new Workspace(workspace),runners=new Map(),streams=new Set();
  const localAgents=new Map();let toolChain=Promise.resolve();
  let actualPort=port,remoteServer,relayConnection,tailscaleAccess,tailscaleMonitor;
  let remoteAccess={mode:tailscale?'tailscale':relay?'relay':'local',enabled:!!relay,connected:false,url:relay?.url||null,error:null};
  const publicState=()=>{
    const state=store.publicState();
    state.workspaceName=path.basename(workspace);
    state.remoteAccess=remoteAccess;
    state.participants=state.participants.map(p=>{const r=runners.get(p.id);return {...p,runner:r?{device:r.device,account:r.account,accountType:r.accountType,accountFingerprint:r.accountFingerprint,online:Date.now()-r.lastSeen<10_000,error:r.error||null}:null};});
    const fingerprints=state.participants.map(p=>p.runner?.accountFingerprint).filter(Boolean);
    state.distinctAccounts=new Set(fingerprints).size;
    state.sameAccount=fingerprints.length>new Set(fingerprints).size;
    return state;
  };
  const broadcast=(kind='state',data=publicState())=>{const event=`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;for(const res of streams){if(res.destroyed||res.writableEnded){streams.delete(res);continue;}if(!res.write(event)){streams.delete(res);res.end();}}};
  function memberFor(req,agent=false) {
    const bearer=req.headers.authorization?.replace(/^Bearer /,'');
    const hash=bearer?digest(bearer):'';
    const member=store.state.participants.find(p=>!p.revoked && same(agent?p.agentTokenHash:p.tokenHash,hash));
    if(!member) {const error=new Error('연결 권한이 없거나 만료되었습니다.');error.status=401;throw error;}
    return member;
  }
  function owner(member) {if(member.role!=='owner'){const e=new Error('호스트 소유자만 사용할 수 있습니다.');e.status=403;throw e;}}
  function turnFor(req,id,payload) {
    const member=memberFor(req,true),turn=store.active;
    if(!turn || turn.id!==id || turn.authorId!==member.id || !same(turn.lease,payload.lease)) throw new Error('만료되었거나 다른 참여자의 실행입니다.');
    const runner=runners.get(member.id);
    if(!runner || runner.runnerId!==turn.runnerId)throw new Error('실행기가 교체되었습니다.');
    runner.lastSeen=Date.now();return {member,turn,runner};
  }
  function pairing(member) {
    const code=randomBytes(6).toString('hex').toUpperCase();
    store.state.pairings=store.state.pairings.filter(p=>p.memberId!==member.id && p.expires>Date.now());
    store.state.pairings.push({hash:digest(code),memberId:member.id,expires:Date.now()+600_000});store.save();return code;
  }
  const hosts=new Set(['localhost','127.0.0.1','[::1]',...Object.values(os.networkInterfaces()).flat().filter(Boolean).map(n=>n.address)]);
  if(listen!=='0.0.0.0' && listen!=='::')hosts.add(listen);
  const handle=async(req,res,remote=false)=>{
    try {
      if(remote&&tailscale&&(!remoteAccess.connected||!remoteAccess.url))return json(res,503,{error:'Tailscale 사설 연결을 준비하고 있습니다.'});
      const remoteOrigin=relay?.url||remoteAccess.url;
      const url=new URL(req.url,remote?remoteOrigin:`http://${req.headers.host}`);
      if(remote&&tailscale&&req.headers.host!==new URL(remoteOrigin).host)return json(res,403,{error:'Tailscale 주소로 접속해 주세요.'});
      // Serve supplies this header for user devices and strips forged inbound values.
      // Requiring it also rejects Funnel traffic. Tagged-device access is unsupported.
      if(remote&&tailscale&&!req.headers['tailscale-user-login'])return json(res,403,{error:'Tailscale 개인 계정으로 연결한 기기에서 접속해 주세요.'});
      if(!remote&&!hosts.has(url.hostname))return json(res,403,{error:'허용하지 않는 호스트 주소입니다.'});
      if(req.headers.origin && req.headers.origin!==url.origin)return json(res,403,{error:'다른 사이트의 요청은 허용하지 않습니다.'});
      const localRequest=!remote&&loopback(req.socket.remoteAddress)&&!Object.keys(req.headers).some(k=>k==='forwarded'||k.startsWith('x-forwarded-')||k.startsWith('tailscale-'));
      const route=url.pathname;
      if(route==='/api/health')return json(res,200,{ok:true,version:'0.1.0'});
      if(route==='/api/bootstrap' && req.method==='POST') {
        if(!localRequest)return json(res,403,{error:'호스트 PC에서 먼저 열어 주세요. 원격 참여에는 초대 링크가 필요합니다.'});
        const {name}=await body(req);
        let member=store.state.participants.find(p=>p.role==='owner' && !p.revoked);
        let secret;
        const secretPath=path.join(dataDir,'owner-token');
        if(!member) {secret=token();member={id:randomUUID(),name:nameOf(name||'나'),role:'owner',tokenHash:digest(secret)};store.state.participants.push(member);await writeFile(secretPath,secret,{mode:0o600});store.save();}
        else secret=await readFile(secretPath,'utf8');
        return json(res,200,{token:secret,member:{id:member.id,name:member.name,role:member.role}});
      }
      if(route==='/api/join' && req.method==='POST') {
        const p=await body(req);const invitation=store.state.invites.find(i=>same(i.hash,digest(p.code||'')) && i.expires>Date.now() && !i.used);
        if(!invitation)return json(res,403,{error:'초대 링크가 만료되었거나 이미 사용되었습니다.'});
        const secret=token();const member={id:randomUUID(),name:nameOf(p.name),role:'member',tokenHash:digest(secret)};
        invitation.used=true;store.state.participants.push(member);store.save();broadcast();return json(res,200,{token:secret,member:{id:member.id,name:member.name,role:member.role}});
      }
      if(route==='/api/agent/pair' && req.method==='POST') {
        const p=await body(req);const code=String(p.code||'').replace(/\s|-/g,'').toUpperCase();
        const entry=store.state.pairings.find(i=>same(i.hash,digest(code)) && i.expires>Date.now());
        if(!entry)return json(res,403,{error:'연결 코드가 만료되었거나 이미 사용되었습니다.'});
        const member=store.state.participants.find(m=>m.id===entry.memberId && !m.revoked);
        if(!member)throw new Error('참여자 권한이 회수되었습니다.');
        if(store.active?.authorId===member.id)throw new Error('현재 턴이 끝난 후 실행기를 다시 연결하세요.');
        const secret=token();member.agentTokenHash=digest(secret);store.state.pairings=store.state.pairings.filter(i=>i!==entry);store.save();
        return json(res,200,{token:secret,member:{id:member.id,name:member.name}});
      }
      if(route.startsWith('/api/worker/')) {
        const member=memberFor(req,true),p=await body(req);
        if(route==='/api/worker/register') {
          if(store.active?.authorId===member.id)throw new Error('활성 턴을 실행 중인 연결을 교체할 수 없습니다.');
          if(typeof p.runnerId!=='string' || typeof p.account!=='string' || p.account.length>200)throw new Error('Invalid runner identity.');
          runners.set(member.id,{...p,lastSeen:Date.now()});broadcast();return json(res,200,{ok:true});
        }
        if(route==='/api/worker/claim') {
          const r=runners.get(member.id);
          if(!r || r.runnerId!==p.runnerId)return json(res,409,{error:'실행기를 다시 연결하세요.'});
          r.lastSeen=Date.now();
          const turn=store.claim(member.id,r.runnerId,r.account,r.accountFingerprint);
          if(turn)broadcast();
          return json(res,200,{job:turn?{...turn,checkpoint:store.state.checkpoint,nativeId:store.state.nativeId}:null});
        }
        const match=route.match(/^\/api\/worker\/turns\/([^/]+)\/(applied|event|tool|heartbeat|complete|fail)$/);
        if(!match)return json(res,404,{error:'Unknown worker route'});
        const {turn}=turnFor(req,match[1],p);
        if(match[2]==='heartbeat')return json(res,200,{cancel:!!turn.cancelRequested});
        if(match[2]==='applied') {
          if(p.hash!==store.state.checkpointHash || p.revision!==store.state.revision || store.state.nativeId && p.nativeId!==store.state.nativeId)throw new Error('최신 세션 적용 검증에 실패했습니다.');
          turn.status='running';turn.appliedHash=p.hash;turn.appliedRevision=p.revision;turn.nativeId=p.nativeId;turn.model=p.model;store.save();broadcast();return json(res,200,{ok:true});
        }
        if(match[2]==='event') {
          if(p.kind==='delta' && typeof p.delta==='string')broadcast('delta',{turnId:turn.id,itemId:p.itemId,delta:p.delta.slice(0,20_000)});
          if(p.kind==='message' && p.item?.type==='agentMessage') {
            const item={id:p.item.id,text:String(p.item.text||'').slice(0,150_000),phase:p.item.phase};
            const i=turn.items.findIndex(x=>x.id===item.id);i<0?turn.items.push(item):turn.items[i]=item;
            store.save();broadcast();
          }
          return json(res,200,{ok:true});
        }
        if(match[2]==='tool') {
          if(turn.status!=='running' || turn.cancelRequested)throw new Error('이 턴에서 도구 실행이 허용되지 않습니다.');
          if(typeof p.callId!=='string' || p.callId.length>200)throw new Error('Invalid call ID.');
          const signature=digest(JSON.stringify({name:p.name,args:p.args}));
          const perform=async()=>{
            turnFor(req,match[1],p);
            const previous=turn.tools.find(t=>t.callId===p.callId);
            if(previous) {if(previous.signature!==signature)throw new Error('같은 도구 호출 ID에 다른 인자가 전달되었습니다.');if(previous.status==='pending')throw new Error('실행 결과 확인이 필요한 도구입니다.');return previous.result;}
            const tool={callId:p.callId,signature,name:p.name,args:p.args,status:'pending',at:new Date().toISOString()};
            turn.tools.push(tool);store.save();broadcast();
            try {tool.result={success:true,output:await files.tool(p.name,p.args||{})};tool.status='completed';}
            catch(error){tool.result={success:false,output:{error:error.message}};tool.status='failed';}
            store.save();broadcast();return tool.result;
          };
          const promise=toolChain.then(perform);toolChain=promise.catch(()=>{});return json(res,200,await promise);
        }
        if(match[2]==='complete') {const result=store.complete(turn,p);broadcast();return json(res,200,{ok:true,...result});}
        if(match[2]==='fail') {store.fail(turn,String(p.error||'세션 저장 실패').slice(0,3000),p.failurePhase);broadcast();return json(res,200,{ok:true});}
      }
      if(route.startsWith('/api/')) {
        const member=memberFor(req);
        if(route==='/api/state')return json(res,200,{...publicState(),me:{id:member.id,name:member.name,role:member.role},canLocalConnect:allowLocalAgent && member.role==='owner' && localRequest,canManageNetwork:member.role==='owner'&&localRequest&&!!tailscaleAccess});
        if(route.startsWith('/api/network/tailscale/')&&req.method==='POST') {
          owner(member);if(!localRequest||!tailscaleAccess)return json(res,403,{error:'호스트 PC에서 Tailscale 연결을 설정하세요.'});
          const action=route.split('/').at(-1);if(!['refresh','enable','disable'].includes(action))return json(res,404,{error:'Unknown Tailscale action.'});
          const result=await tailscaleAccess[action]();broadcast();return json(res,result.error?409:200,result);
        }
        if(route==='/api/events') {
          // Fetch-based SSE uses Authorization; credentials never appear in stream URLs.
          res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});
          res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);streams.add(res);res.memberId=member.id;res.on('close',()=>streams.delete(res));return;
        }
        if(route==='/api/files')return json(res,200,{files:await files.list()});
        if(route==='/api/file')return json(res,200,await files.read(url.searchParams.get('path')));
        if(route==='/api/invites' && req.method==='POST') {owner(member);if(tailscaleAccess){await tailscaleAccess.refresh();if(!remoteAccess.connected)return json(res,409,{error:remoteAccess.error||'Tailscale 연결을 먼저 켜 주세요. 원격 초대에 로컬 주소를 사용하지 않습니다.'});}const code=token();store.state.invites.push({hash:digest(code),expires:Date.now()+86400_000,used:false});store.save();return json(res,200,{code,expiresIn:86400,url:remoteAccess.connected?remoteAccess.url:null,mode:remoteAccess.mode});}
        if(route==='/api/pairing' && req.method==='POST')return json(res,200,{code:pairing(member)});
        if(route==='/api/local-agent' && req.method==='POST') {
          owner(member);if(!allowLocalAgent || !localRequest)return json(res,403,{error:'호스트 PC의 소유자만 로컬 실행기를 연결할 수 있습니다.'});
          const old=localAgents.get(member.id);if(old && !old.controller.signal.aborted)return json(res,200,{ok:true});
          const pair=pairing(member),controller=new AbortController(),entry={controller};localAgents.set(member.id,entry);
          entry.promise=runAgent({host:`http://127.0.0.1:${actualPort}`,pair,dataDir:path.join(dataDir,'local-agent'),signal:controller.signal,log:()=>{}}).catch(error=>{controller.abort();runners.set(member.id,{lastSeen:0,error:error.message});broadcast();});
          return json(res,200,{ok:true});
        }
        if(route==='/api/turns' && req.method==='POST') {const p=await body(req);const turn=store.enqueue(member,p.prompt,p.requestId);broadcast();return json(res,200,{turn});}
        const retry=route.match(/^\/api\/turns\/([^/]+)\/retry$/);
        if(retry && req.method==='POST') {
          const turn=store.state.turns.find(t=>t.id===retry[1]);
          if(!turn || turn.authorId!==member.id)return json(res,403,{error:'내 작업만 다시 실행할 수 있습니다.'});
          if(turn.retriedAs) return json(res,200,{turn:store.state.turns.find(t=>t.id===turn.retriedAs)});
          const next=store.retry(turn);broadcast();return json(res,200,{turn:next});
        }
        const cancel=route.match(/^\/api\/turns\/([^/]+)\/cancel$/);
        if(cancel && req.method==='POST') {
          const turn=store.state.turns.find(t=>t.id===cancel[1]);
          if(!turn || turn.authorId!==member.id && member.role!=='owner')return json(res,403,{error:'내 작업만 중단할 수 있습니다.'});
          if(turn.status==='queued')turn.status='cancelled';else if(['running','syncing'].includes(turn.status))turn.cancelRequested=true;
          store.save();broadcast();return json(res,200,{ok:true});
        }
        if(route==='/api/session/new' && req.method==='POST') {
          owner(member);if(store.active)throw new Error('진행 중인 턴을 먼저 중단해 주세요.');
          const p=await body(req);await mkdir(path.join(dataDir,'archives'),{recursive:true});
          await writeFile(path.join(dataDir,'archives',`${store.state.id}.json`),JSON.stringify(store.state),{mode:0o600});
          Object.assign(store.state,{id:randomUUID(),title:typeof p.title==='string'?p.title.slice(0,80):'새로운 프로젝트',revision:0,nativeId:null,checkpoint:'',checkpointHash:digest(''),turns:[],blocked:null,createdAt:new Date().toISOString()});
          store.save();broadcast();return json(res,200,{ok:true});
        }
        const revoke=route.match(/^\/api\/members\/([^/]+)\/revoke$/);
        if(revoke && req.method==='POST') {
          owner(member);const target=store.state.participants.find(p=>p.id===revoke[1] && p.role!=='owner');if(!target)throw new Error('회수할 참여자가 없습니다.');
          if(store.active?.authorId===target.id)throw new Error('해당 참여자의 실행을 중단하고 저장이 끝난 후 권한을 회수하세요.');
          target.revoked=true;for(const turn of store.state.turns)if(turn.authorId===target.id && turn.status==='queued')turn.status='cancelled';
          for(const stream of streams)if(stream.memberId===target.id){streams.delete(stream);stream.end();}runners.delete(target.id);store.save();broadcast();return json(res,200,{ok:true});
        }
        return json(res,404,{error:'Unknown route'});
      }
      if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
      const staticFiles={'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
      const file=staticFiles[route];if(!file)return json(res,404,{error:'Not found'});
      res.writeHead(200,{'Content-Type':file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-src 'self' about:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",'Referrer-Policy':'no-referrer'});
      res.end(await readFile(path.join(here,'../public',file)));
    } catch(error) {if(!res.headersSent)json(res,error.status||400,{error:error.message});else res.end();}
  };
  const server=http.createServer((req,res)=>handle(req,res));
  const monitor=setInterval(()=>{
    const active=store.active;
    if(active) {const runner=runners.get(active.authorId);if(!runner || Date.now()-runner.lastSeen>45_000){store.fail(active,'실행기 연결이 끊겨 세션 저장을 확인할 수 없습니다.');broadcast();}}
    for(const res of streams)if(!res.destroyed&&!res.writableEnded)res.write(': heartbeat\n\n');else streams.delete(res);
    broadcast();
  },5000);
  monitor.unref();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,listen,resolve);});actualPort=server.address().port;
  if(relay||tailscale) {
    remoteServer=http.createServer((req,res)=>handle(req,res,true));
    await new Promise((resolve,reject)=>{remoteServer.once('error',reject);remoteServer.listen(0,'127.0.0.1',resolve);});
    const onStatus=status=>{const changed=JSON.stringify(remoteAccess)!==JSON.stringify(status);remoteAccess=status;if(changed)broadcast();};
    if(relay)relayConnection=connectRelay({...relay,localUrl:`http://127.0.0.1:${remoteServer.address().port}`,onStatus:status=>onStatus({mode:'relay',...status})});
    else {
      tailscaleAccess=new TailscaleAccess({...tailscale,dataDir,target:`http://127.0.0.1:${remoteServer.address().port}`,onStatus});
      if(tailscale.autoStart)await tailscaleAccess.enable();else await tailscaleAccess.refresh();
      tailscaleMonitor=setInterval(()=>tailscaleAccess.refresh(),15_000);tailscaleMonitor.unref();
    }
  }
  return {server,store,files,url:`http://127.0.0.1:${actualPort}`,port:actualPort,
    async close() {clearInterval(monitor);clearInterval(tailscaleMonitor);for(const entry of localAgents.values())entry.controller.abort();await Promise.allSettled([...localAgents.values()].map(entry=>entry.promise));for(const res of streams)res.end();await tailscaleAccess?.close();await relayConnection?.close();if(remoteServer){remoteServer.closeAllConnections();await new Promise(resolve=>remoteServer.close(resolve));}server.closeAllConnections();await new Promise(resolve=>server.close(resolve));try{unlinkSync(lockFile);}catch{}},
  };
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),get=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
  const relayUrl=get('--relay',process.env.HIH_RELAY_URL),keyFile=get('--relay-key-file',process.env.HIH_RELAY_KEY_FILE);
  const keyPromise=relayUrl?(keyFile?readFile(path.resolve(keyFile),'utf8'):Promise.resolve(process.env.HIH_RELAY_KEY||'')):Promise.resolve('');
  keyPromise.then(key=>createHost({port:Number(get('--port','4317')),listen:get('--listen','127.0.0.1'),dataDir:path.resolve(get('--data','.hih')),workspace:path.resolve(get('--workspace','workspace')),relay:relayUrl?{url:relayUrl,key:key.trim()}:undefined,tailscale:!relayUrl&&!args.includes('--no-tailscale')?{autoStart:args.includes('--tailscale'),httpsPort:Number(get('--tailscale-port','8443'))}:false})).then(host=>{
    console.log(`hand-in-hand → ${host.url}\n공유 폴더: ${path.resolve(get('--workspace','workspace'))}\nCodex 연결은 화면에서 시작하세요.`);
    const stop=()=>host.close().then(()=>process.exit());process.once('SIGINT',stop);process.once('SIGTERM',stop);
  }).catch(error=>{console.error(error.message);process.exitCode=1;});
}
