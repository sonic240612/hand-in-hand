import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { relayOrigin, validRelayPath, responseHeaders } from './relay.mjs';

// The host makes only outbound HTTPS requests. Browsers and agents need no VPN.
// The fixed loopback destination is a dedicated listener that NEVER bootstraps an owner.
export function connectRelay({url,key,localUrl,onStatus=()=>{},retryMs=2000}) {
  const origin=relayOrigin(url),local=new URL(localUrl);
  if(local.protocol!=='http:'||local.hostname!=='127.0.0.1')throw new Error('중계 대상은 전용 loopback 서버여야 합니다.');
  const controller=new AbortController(),clientId=randomUUID(),active=new Set();let connected=false;
  const headers={Authorization:`Bearer ${key}`,'X-Hih-Connector':clientId};
  const report=(online,error=null)=>{connected=online;onStatus({enabled:true,connected:online,url:origin,error});};
  const request=(route,options={})=>fetch(origin+route,{...options,headers:{...headers,...options.headers},redirect:'error',signal:options.signal||controller.signal});
  async function execute(job) {
    const cancel=new AbortController(),signal=AbortSignal.any([controller.signal,cancel.signal,AbortSignal.timeout(610_000)]);
    try {
      if(!validRelayPath(job.path)||!['GET','POST'].includes(job.method))throw new Error('중계 요청 경로가 잘못되었습니다.');
      const allowed={};for(const name of ['authorization','content-type','origin'])if(typeof job.headers?.[name]==='string')allowed[name]=job.headers[name];
      const response=await fetch(local.origin+job.path,{method:job.method,headers:allowed,body:job.method==='POST'?Buffer.from(job.body||'','base64'):undefined,signal,redirect:'error'});
      const result=await request('/_relay/reply/'+job.id,{method:'POST',headers:{'X-Hih-Status':String(response.status),'X-Hih-Headers':Buffer.from(JSON.stringify(responseHeaders(Object.fromEntries(response.headers)))).toString('base64url'),'Content-Type':'application/octet-stream'},body:response.body,duplex:'half',signal});
      await result.arrayBuffer();
    } catch(error) {
      // A dispatched mutation is never replayed after an ambiguous disconnect.
      if(!controller.signal.aborted&&error.name!=='AbortError')onStatus({enabled:true,connected,url:origin,error:'중계 요청 하나가 종료되었습니다. 연결 상태를 다시 확인합니다.'});
    } finally {cancel.abort();}
  }
  const done=(async()=>{
    while(!controller.signal.aborted) {
      try {
        const result=await request('/_relay/connect',{method:'POST',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)])});
        if(!result.ok){await result.arrayBuffer();throw new Error(`중계 호스트 연결 실패 (${result.status}). 주소와 연결 키를 확인하세요.`);}await result.arrayBuffer();report(true);
        while(!controller.signal.aborted) {
          const response=await request('/_relay/next',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20_000)])});
          if(response.status===204){report(true);continue;}
          if(!response.ok){await response.arrayBuffer();throw new Error(`중계 연결 실패 (${response.status}).`);}
          const {job}=await response.json();report(true);
          if(active.size>=32)throw new Error('중계 처리 수 제한을 초과했습니다.');
          const task=execute(job);active.add(task);task.finally(()=>active.delete(task));
        }
      } catch(error) {if(controller.signal.aborted)break;report(false,error.message);try{await sleep(retryMs,undefined,{signal:controller.signal});}catch{}}
    }
  })();
  return {done,async close(){controller.abort();await done;await Promise.allSettled([...active]);try{await request('/_relay/disconnect',{method:'POST',signal:AbortSignal.timeout(2000)});}catch{}report(false);}};
}
