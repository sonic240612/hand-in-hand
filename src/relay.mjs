import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const MAX_BODY=34*1024*1024, MAX_BUFFERED=68*1024*1024, MAX_REQUESTS=32;
const json=(res,status,data)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
const hash=value=>createHash('sha256').update(value).digest();
export function relayOrigin(value) {
  const url=new URL(value);
  if(url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('중계 주소에는 도메인과 포트만 지정하세요.');
  if(url.protocol!=='https:' && !(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new Error('인터넷 중계에는 HTTPS 주소가 필요합니다. HTTP는 이 PC의 테스트에만 허용합니다.');
  return url.origin;
}
export function validRelayPath(value) {
  if(typeof value!=='string'||value.length>4096||!value.startsWith('/')||value.startsWith('//')||/[\\\r\n]/.test(value))return false;
  try {const decoded=decodeURIComponent(value.split('?')[0]);return !decoded.includes('..')&&!decoded.includes('\\')&&!decoded.startsWith('//')&&!decoded.startsWith('/_relay');}catch{return false;}
}
export function responseHeaders(headers) {
  const allow=['content-type','cache-control','content-security-policy','x-content-type-options','referrer-policy'];
  return Object.fromEntries(allow.filter(k=>headers[k]!==undefined).map(k=>[k,String(headers[k])]));
}

// One relay process serves one host. Only ephemeral request buffers are retained.
// TLS terminates at a trusted deployment proxy; this is not an E2E-encrypted relay.
export async function createRelay({port=4318,listen='127.0.0.1',key,publicUrl,pollMs=10_000,offlineMs=35_000}={}) {
  if(typeof key!=='string'||!/^[A-Za-z0-9_-]{43,128}$/.test(key))throw new Error('32바이트 이상 무작위 중계 키가 필요합니다.');
  let origin=publicUrl?relayOrigin(publicUrl):null;
  if(!origin&&!['127.0.0.1','::1','localhost'].includes(listen))throw new Error('외부 중계에는 --public-url HTTPS 주소가 필요합니다.');
  const keyHash=hash(`Bearer ${key}`),pending=new Map();let connector=null,waiter=null,buffered=0,reservations=0,closing=false;
  const online=()=>!!connector&&Date.now()-connector.seen<offlineMs;
  const permitted=req=>timingSafeEqual(hash(req.headers.authorization||''),keyHash);
  const identify=req=>online()&&req.headers['x-hih-connector']===connector.id;
  function finish(entry,status,message) {if(!entry)return;clearTimeout(entry.timer);pending.delete(entry.id);buffered-=entry.bytes;entry.bytes=0;if(status&&!entry.res.headersSent)json(entry.res,status,{error:message});else if(status)entry.res.destroy();}
  function disconnect(message) {if(waiter){clearTimeout(waiter.timer);json(waiter.res,409,{error:message});waiter=null;}connector=null;for(const entry of [...pending.values()])finish(entry,503,message);}
  function dispatch(res) {
    const entry=[...pending.values()].find(p=>!p.claimed);
    if(!entry)return false;
    entry.claimed=true;
    json(res,200,{job:{id:entry.id,method:entry.method,path:entry.path,headers:entry.headers,body:entry.body}});
    buffered-=entry.bytes;entry.bytes=0;entry.body='';return true;
  }
  const server=http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,origin);
      if(req.headers.origin&&req.headers.origin!==origin)return json(res,403,{error:'다른 사이트의 요청은 허용하지 않습니다.'});
      if(url.pathname.startsWith('/_relay/')) {
        if(!permitted(req))return json(res,401,{error:'중계 호스트 인증이 필요합니다.'});
        if(url.pathname==='/_relay/connect'&&req.method==='POST') {
          const id=req.headers['x-hih-connector'];if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))return json(res,400,{error:'Invalid connector.'});
          if(online()&&connector.id!==id)return json(res,409,{error:'이미 다른 호스트가 이 중계에 연결되어 있습니다.'});
          if(connector?.id!==id)disconnect('호스트 연결이 변경되었습니다.');
          connector={id,seen:Date.now()};return json(res,200,{ok:true});
        }
        if(!identify(req))return json(res,409,{error:'호스트를 다시 연결하세요.'});
        connector.seen=Date.now();
        if(url.pathname==='/_relay/disconnect'&&req.method==='POST'){disconnect('호스트가 연결을 종료했습니다.');return json(res,200,{ok:true});}
        if(url.pathname==='/_relay/next'&&req.method==='GET') {
          if(waiter)return json(res,409,{error:'하나의 수신 연결만 허용합니다.'});
          if(dispatch(res))return;
          const entry={res,timer:setTimeout(()=>{if(waiter===entry){waiter=null;res.writeHead(204);res.end();}},pollMs)};
          waiter=entry;res.on('close',()=>{if(waiter===entry){clearTimeout(entry.timer);waiter=null;}});return;
        }
        const reply=url.pathname.match(/^\/_relay\/reply\/([a-f0-9-]{36})$/);
        if(reply&&req.method==='POST') {
          const entry=pending.get(reply[1]);if(!entry?.claimed||entry.replied)return json(res,410,{error:'요청이 끝났습니다. 재실행하지 마세요.'});
          const status=Number(req.headers['x-hih-status']);if(!Number.isInteger(status)||status<200||status>599)return json(res,400,{error:'Invalid response status.'});
          const encoded=req.headers['x-hih-headers'];if(typeof encoded!=='string'||encoded.length>12_000)return json(res,400,{error:'Invalid response headers.'});
          const headers=responseHeaders(JSON.parse(Buffer.from(encoded,'base64url').toString()));
          entry.replied=true;clearTimeout(entry.timer);
          const isStream=headers['content-type']?.startsWith('text/event-stream');
          entry.timer=isStream?null:setTimeout(()=>finish(entry,504,'중계 응답 시간이 만료되었습니다.'),60_000);
          entry.res.writeHead(status,{...headers,'Cache-Control':'no-store','X-Accel-Buffering':'no'});entry.res.flushHeaders();
          try {await pipeline(req,entry.res);json(res,200,{ok:true});}catch {if(!res.destroyed)json(res,410,{error:'참여자 연결이 끝났습니다.'});}finally{finish(entry);}
          return;
        }
        return json(res,404,{error:'Unknown relay route.'});
      }
      if(!['GET','POST'].includes(req.method)||!validRelayPath(req.url))return json(res,400,{error:'허용하지 않는 요청입니다.'});
      if(!online())return json(res,503,{error:'호스트 PC가 오프라인입니다. 호스트가 앱을 켜면 다시 연결할 수 있습니다.'});
      if(pending.size+reservations>=MAX_REQUESTS)return json(res,429,{error:'연결이 많습니다. 잠시 후 다시 시도하세요.'});
      // Limit concurrent uploads as well as queued requests before buffering bodies.
      reservations++;let bytes=0,chunks=[];
      try {
        for await(const chunk of req){if(bytes+chunk.length>MAX_BODY||buffered+chunk.length>MAX_BUFFERED){const e=new Error('요청 크기 제한을 초과했습니다.');e.status=413;throw e;}bytes+=chunk.length;buffered+=chunk.length;chunks.push(chunk);}
        if(closing||!online()){const e=new Error('호스트 연결이 끊겼습니다.');e.status=503;throw e;}
        const id=randomUUID(),headers={};
        for(const name of ['authorization','content-type','origin'])if(req.headers[name])headers[name]=req.headers[name];
        const entry={id,res,method:req.method,path:req.url,headers,body:Buffer.concat(chunks).toString('base64'),bytes,claimed:false};
        entry.timer=setTimeout(()=>finish(entry,504,'호스트 응답을 기다리다 시간이 만료되었습니다. 작업을 자동 재실행하지 않습니다.'),45_000);
        pending.set(id,entry);bytes=0;chunks=[];
        res.on('close',()=>finish(entry));
        if(waiter){const current=waiter;waiter=null;clearTimeout(current.timer);dispatch(current.res);}
      } finally {reservations--;buffered-=bytes;}
    } catch(error){if(!res.headersSent)json(res,error.status||400,{error:error.message});else res.destroy();}
  });
  // Long-running execution streams stay open until the turn, participant, host,
  // or network closes them. Short non-streaming relay replies still time out.
  server.requestTimeout=0;server.headersTimeout=15_000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,listen,resolve);});
  origin ||= `http://127.0.0.1:${server.address().port}`;
  const monitor=setInterval(()=>{if(connector&&!online())disconnect('호스트 연결이 끊겼습니다.');},Math.min(1000,offlineMs));monitor.unref();
  return {server,url:`http://127.0.0.1:${server.address().port}`,publicUrl:origin,
    async close(){closing=true;clearInterval(monitor);disconnect('중계 서버를 종료했습니다.');server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),get=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
  const keyFile=get('--key-file',process.env.HIH_RELAY_KEY_FILE);
  const keyPromise=keyFile?readFile(path.resolve(keyFile),'utf8'):Promise.resolve(process.env.HIH_RELAY_KEY||'');
  keyPromise.then(key=>createRelay({port:Number(get('--port','4318')),listen:get('--listen','127.0.0.1'),key:key.trim(),publicUrl:get('--public-url',process.env.HIH_RELAY_URL)})).then(relay=>{
    console.log(`hand-in-hand relay → ${relay.publicUrl}\n호스트의 연결을 기다립니다.`);
    const stop=()=>relay.close().then(()=>process.exit());process.once('SIGINT',stop);process.once('SIGTERM',stop);
  }).catch(error=>{console.error(error.message);process.exitCode=1;});
}
