import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { TailscaleAccess } from './tailscale.mjs';

// A separate origin is essential: project JavaScript must never run in the
// collaboration UI's origin, where participant credentials are stored.
export async function createPreview({dataDir,validMember,appOrigins,tailscale,blockedPorts=()=>[],onChange=()=>{}}){
  let targetPort=null,access=null,remoteUrl=null;
  if(tailscale){
    // Remove only the exact previously owned Serve endpoint after a crash;
    // its old ephemeral local port might later be assigned to another process.
    const directory=path.join(dataDir,'preview-network');
    let saved;try{saved=JSON.parse(await readFile(path.join(directory,'tailscale-access.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(saved){const previous=new TailscaleAccess({...tailscale,dataDir:directory,target:saved.target,httpsPort:saved.port});const state=await previous.refresh();if(state.connected)await previous.close();}
  }
  const tickets=new Map(),sockets=new Set(),requests=new Set();
  const secret=()=>randomBytes(32).toString('base64url');
  const server=http.createServer(handle);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port,localUrl=`http://127.0.0.1:${port}`,cookieName=`hih_preview_${port}`;
  function originFor(req){
    const host=req.headers.host;
    if(host===new URL(localUrl).host)return localUrl;
    if(remoteUrl&&host===new URL(remoteUrl).host&&req.headers['tailscale-user-login']&&access?.state.connected)return remoteUrl;
    throw new Error('허용된 미리보기 주소로 접속해 주세요.');
  }
  function session(req){
    const value=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    const entry=tickets.get(value);if(!entry||!entry.authenticated||entry.expires<Date.now()||!validMember(entry.member))throw new Error('미리보기 권한이 만료되었습니다. 앱에서 다시 열어 주세요.');return entry;
  }
  function headers(req){
    // Do not pass session cookies, participant tokens or proxy identity headers
    // to project code. It receives only ordinary application headers.
    const out={};for(const key of ['accept','accept-language','content-type','content-length','range','if-none-match','sec-websocket-key','sec-websocket-version','sec-websocket-protocol','sec-websocket-extensions'])if(req.headers[key])out[key]=req.headers[key];
    out.host=`127.0.0.1:${targetPort}`;if(req.headers.origin)out.origin=`http://127.0.0.1:${targetPort}`;return out;
  }
  function fail(res,error,status=403){res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end(error.message);}
  function handle(req,res){
    try{
      const origin=originFor(req),url=new URL(req.url,origin);
      if(!targetPort)throw new Error('호스트가 개발 서버 미리보기를 켜야 합니다.');
      if(req.headers.origin&&req.headers.origin!==origin)throw new Error('다른 사이트의 요청은 허용하지 않습니다.');
      if(url.pathname==='/__hih/open'){
        const entry=tickets.get(url.searchParams.get('ticket'));
        if(req.method!=='GET'||!entry||entry.authenticated||entry.expires<Date.now()||!validMember(entry.member))throw new Error('미리보기 링크가 만료되었습니다.');
        tickets.delete(url.searchParams.get('ticket'));const cookie=secret();tickets.set(cookie,{...entry,authenticated:true,expires:Date.now()+3600_000});
        res.writeHead(303,{'Set-Cookie':`${cookieName}=${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600${origin.startsWith('https:')?'; Secure':''}`,'Location':'/','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});return res.end();
      }
      const entry=session(req);
      const upstream=http.request({hostname:'127.0.0.1',port:targetPort,path:url.pathname+url.search,method:req.method,headers:headers(req)},response=>{
        const out={...response.headers};for(const key of ['set-cookie','www-authenticate','access-control-allow-origin','access-control-allow-credentials','content-security-policy','content-security-policy-report-only','x-frame-options'])delete out[key];
        if(out.location){const dest=new URL(out.location,`http://127.0.0.1:${targetPort}`);if(dest.origin!==`http://127.0.0.1:${targetPort}`){response.destroy();return fail(res,new Error('외부 주소 리디렉션은 미리보기에서 지원하지 않습니다.'),502);}out.location=dest.pathname+dest.search+dest.hash;}
        out['content-security-policy']=`frame-ancestors ${appOrigins().join(' ')}; base-uri 'self'; form-action 'self'`;
        out['referrer-policy']='no-referrer';out['cache-control']='no-store';out['x-content-type-options']='nosniff';
        res.writeHead(response.statusCode,out);response.pipe(res);
      });
      upstream.setTimeout(30_000,()=>upstream.destroy(new Error('개발 서버 응답 시간이 초과되었습니다.')));
      upstream.on('error',error=>{if(!res.headersSent)fail(res,new Error('개발 서버에 연결할 수 없습니다: '+error.message),502);else res.destroy();});
      const connection={entry,res,upstream};requests.add(connection);
      res.on('close',()=>{requests.delete(connection);upstream.destroy();});req.pipe(upstream);
    }catch(error){fail(res,error);}
  }
  server.on('upgrade',(req,socket,head)=>{
    try{
      const origin=originFor(req),entry=session(req);
      if(!targetPort||req.headers.origin!==origin)throw new Error('WebSocket 권한이 없습니다.');
      const upstream=http.request({hostname:'127.0.0.1',port:targetPort,path:req.url,headers:{...headers(req),connection:'Upgrade',upgrade:'websocket'}});
      upstream.on('upgrade',(response,peer,upstreamHead)=>{
        socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(response.headers).filter(([k])=>['upgrade','connection','sec-websocket-accept','sec-websocket-protocol','sec-websocket-extensions'].includes(k)).map(([k,v])=>`${k}: ${v}\r\n`).join('')+'\r\n');
        const connection={socket,peer,entry};sockets.add(connection);
        if(head.length)peer.write(head);if(upstreamHead.length)socket.write(upstreamHead);socket.pipe(peer).pipe(socket);
        const close=()=>{sockets.delete(connection);socket.destroy();peer.destroy();};socket.on('error',close);peer.on('error',close);socket.on('close',close);peer.on('close',close);
      });
      upstream.on('response',()=>socket.destroy());upstream.on('error',()=>socket.destroy());upstream.setTimeout(10_000,()=>upstream.destroy());upstream.end();
    }catch{socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');}
  });
  const sweep=setInterval(()=>{
    for(const [key,entry]of tickets)if(entry.expires<Date.now()||!validMember(entry.member))tickets.delete(key);
    for(const c of sockets)if(c.entry.expires<Date.now()||!validMember(c.entry.member)){c.socket.destroy();c.peer.destroy();sockets.delete(c);}
    for(const c of requests)if(c.entry.expires<Date.now()||!validMember(c.entry.member)){c.res.destroy();c.upstream.destroy();requests.delete(c);}
  },1000);sweep.unref();
  function reset(){tickets.clear();for(const c of sockets){c.socket.destroy();c.peer.destroy();}sockets.clear();for(const c of requests){c.res.destroy();c.upstream.destroy();}requests.clear();}
  return {
    port,
    state:()=>({enabled:!!targetPort,targetPort,localUrl:targetPort?localUrl:null,remoteUrl:access?.state.connected?remoteUrl:null,error:access?.state.error||null}),
    async configure(value){
      if(value!==null&&(!Number.isInteger(value)||value<1024||value>65535||[port,...blockedPorts()].includes(value)))throw new Error('앱 포트를 제외한 개발 서버 포트(1024~65535)를 입력하세요.');
      reset();targetPort=value;
      if(tailscale&&value){
        if(!access){const directory=path.join(dataDir,'preview-network');await mkdir(directory,{recursive:true});access=new TailscaleAccess({...tailscale,dataDir:directory,target:localUrl,httpsPort:tailscale.httpsPort===8444?8445:8444,onStatus:s=>{remoteUrl=s.url;onChange();}});}
        await access.enable();
      }else if(access?.state.connected)await access.disable();
      onChange();return this.state();
    },
    issue(member,remote=false){
      if(!targetPort)throw new Error('개발 서버를 먼저 연결하세요.');
      const origin=remote?(access?.state.connected?remoteUrl:null):localUrl;
      if(!origin)throw new Error('원격 개발 서버 미리보기 연결이 준비되지 않았습니다.');
      const ticket=secret();tickets.set(ticket,{member,expires:Date.now()+60_000});return {url:`${origin}/__hih/open?ticket=${ticket}`,expiresIn:3600};
    },
    async close(){clearInterval(sweep);reset();await access?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));},
  };
}
