const networkCodes=new Set(['ECONNREFUSED','ECONNRESET','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','EPIPE','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET']);

export function isTransientConnectionError(error){
  if(Number.isInteger(error?.status))return error.status===408||error.status===429||(error.status>=500&&error.status<=599);
  return error?.connectionFailure===true||networkCodes.has(error?.code)||networkCodes.has(error?.cause?.code);
}

export function abortableDelay(ms,signal){
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const finish=()=>{signal?.removeEventListener('abort',abort);resolve();};
    const timer=setTimeout(finish,ms);
    const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason);};
    signal?.addEventListener('abort',abort,{once:true});
  });
}

// Only transport and explicitly temporary HTTP failures are retried. A saved
// checkpoint or permission failure must reach the operator without replaying it.
export function createConnectionRetry({signal,log=()=>{},sleep=abortableDelay,initialDelayMs=1000,maxDelayMs=10_000}={}){
  if(!Number.isFinite(initialDelayMs)||initialDelayMs<=0||!Number.isFinite(maxDelayMs)||maxDelayMs<initialDelayMs)throw new Error('Invalid reconnect delay.');
  let disconnected=false;
  return async operation=>{
    let delay=initialDelayMs;
    while(true){
      signal?.throwIfAborted();
      try{
        const result=await operation();
        signal?.throwIfAborted();
        if(disconnected){disconnected=false;log('호스트에 다시 연결했습니다. 저장 기록을 확인하고 이어갑니다.');}
        return result;
      }catch(error){
        signal?.throwIfAborted();
        if(!isTransientConnectionError(error))throw error;
        if(!disconnected){disconnected=true;log('호스트 연결을 기다립니다. 최대 10초 간격으로 자동 재접속합니다. Ctrl+C로 종료할 수 있습니다.');}
        await sleep(delay,signal);
        delay=Math.min(delay*2,maxDelayMs);
      }
    }
  };
}
