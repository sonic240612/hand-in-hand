import http from 'node:http';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import WebSocket, {WebSocketServer} from 'ws';
import {runtimeEnvironment} from './codex-runtime.mjs';

const MAX_FRAME=16*1024*1024,MAX_BUFFER=32*1024*1024;
const frame=(data,binary)=>({data:Buffer.from(data).toString('base64'),binary});
export function prepareHostExecFrame(data,binary,platform=process.platform,windowsRoot=process.env.SystemRoot||'C:\\Windows') {
  if(platform!=='win32'||binary)return data;
  let message;try{message=JSON.parse(data.toString('utf8'));}catch{return data;}
  const argv=message?.params?.argv;
  if(message?.method!=='process/start'||!Array.isArray(argv)||typeof argv[0]!=='string'||!path.win32.isAbsolute(argv[0])||/["\r\n\0]/.test(argv[0])||!/^(?:pwsh|powershell)\.exe$/i.test(path.win32.basename(argv[0])))return data;
  const index=argv.findIndex((arg,i)=>i>0&&typeof arg==='string'&&arg.toLowerCase()==='-command');
  if(index<0||index!==argv.length-2||typeof argv[index+1]!=='string'||message.params.arg0||argv.slice(1,index).some(arg=>!/^-(?:noprofile|nologo|noninteractive)$/i.test(arg)))return data;
  if(!path.win32.isAbsolute(windowsRoot)||/["\r\n\0]/.test(windowsRoot))return data;
  // ConstrainedLanguage blocks Console.OutputEncoding setters. Set the private
  // console code page before PowerShell starts, keeping its sandbox unchanged.
  // CMD sees only fixed switches and base64, never the original script text.
  const encoded=Buffer.from(argv[index+1],'utf16le').toString('base64');
  // Preserve commands that would exceed CMD's smaller command-line limit.
  if(encoded.length+argv[0].length+windowsRoot.length+256>8000)return data;
  message.params.env={...message.params.env,HIH_EXEC_UTF8_POWERSHELL:'"'+argv[0]+'"',HIH_EXEC_UTF8_CHCP:'"'+path.win32.join(windowsRoot,'System32','chcp.com')+'"'};
  message.params.argv=[path.win32.join(windowsRoot,'System32','cmd.exe'),'/d','/v:off','/s','/c',`%HIH_EXEC_UTF8_CHCP% 65001 >nul && %HIH_EXEC_UTF8_POWERSHELL% ${argv.slice(1,index).join(' ')} -EncodedCommand ${encoded}`];
  return Buffer.from(JSON.stringify(message));
}

// Native exec-server stays on loopback. Its protocol travels through the same
// authenticated, leased HTTP routes as the session, including the optional relay.
export async function startHostExec({workspace,dataDir,executable=process.env.HIH_CODEX_BIN||'codex'}={}) {
  const runtimeHome=path.resolve(dataDir,'exec-runtime');await mkdir(runtimeHome,{recursive:true});
  const child=spawn(executable,['exec-server','--listen','ws://127.0.0.1:0','--concurrent-requests','16'],{
    cwd:workspace,env:runtimeEnvironment(process.env,runtimeHome),windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stderr='',socket,stream,ended=false,sequence=0,buffered=0,queue=[];
  child.stdin.on('error',()=>{});
  child.stderr.on('data',b=>{stderr=(stderr+b).slice(-2000);});
  const exited=new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve);});
  const close=()=>{
    if(ended)return;ended=true;
    if(stream&&!stream.writableEnded){stream.write('event: closed\ndata: {}\n\n');stream.end();}
    socket?.terminate();child.stdin.end();child.kill();
  };
  child.once('exit',close);
  try {
    const url=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Codex exec-server 시작 시간 초과. CLI 업데이트를 확인하세요.')),10_000);
      const lines=createInterface({input:child.stdout});
      const onError=error=>done(error),onExit=()=>done(new Error('Codex exec-server 시작 실패: '+stderr));
      const done=(error,value)=>{clearTimeout(timer);lines.close();child.off('error',onError);child.off('exit',onExit);error?reject(error):resolve(value);};
      child.once('error',onError);child.once('exit',onExit);
      lines.on('line',value=>{if(/^ws:\/\/127\.0\.0\.1:\d+\/?$/.test(value.trim()))done(null,value.trim());});
    });
    socket=new WebSocket(url,{maxPayload:MAX_FRAME,handshakeTimeout:10_000});
    socket.on('message',(data,binary)=>{
      const packet='data: '+JSON.stringify(frame(data,binary))+'\n\n';
      if(stream) {
        if(stream.writableLength>MAX_BUFFER)return close();
        if(!stream.write(packet))socket.pause();
      } else {
        buffered+=Buffer.byteLength(packet);if(buffered>MAX_BUFFER)return close();queue.push(packet);
      }
    });
    socket.on('error',close);socket.on('close',close);
    await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
  }catch(error){close();await exited;throw error;}
  return {
    get closed(){return ended;},
    attach(res) {
      if(ended||stream)throw new Error('실행 환경 스트림이 종료되었거나 이미 연결되어 있습니다.');
      stream=res;res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      res.write(': connected\n\n');for(const packet of queue)res.write(packet);queue=[];buffered=0;
      res.on('drain',()=>socket.resume());res.on('close',close);
    },
    async send(packet) {
      if(ended||packet.sequence!==sequence+1||typeof packet.data!=='string'||typeof packet.binary!=='boolean'||packet.data.length>MAX_FRAME*1.4)throw new Error('잘못되었거나 중복된 실행 환경 메시지입니다.');
      const original=Buffer.from(packet.data,'base64');if(original.length>MAX_FRAME||original.toString('base64')!==packet.data)throw new Error('Invalid execution frame.');
      const data=prepareHostExecFrame(original,packet.binary);if(data.length>MAX_FRAME)throw new Error('Execution frame too large.');
      sequence++;
      await new Promise((resolve,reject)=>socket.send(data,{binary:packet.binary},error=>error?reject(error):resolve()));
    },
    async close(){close();await exited;},
  };
}

export async function connectHostExec({host,token,job,signal}) {
  signal?.throwIfAborted();
  const route=`/api/worker/turns/${job.id}/exec`,headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  const controller=new AbortController(),combined=signal?AbortSignal.any([controller.signal,signal]):controller.signal;
  const request=async(suffix,body)=>{
    const res=await fetch(host+route+suffix,{method:'POST',headers,body:JSON.stringify({lease:job.lease,...body}),signal:AbortSignal.any([combined,AbortSignal.timeout(35_000)])});
    const result=await res.json();if(!res.ok)throw new Error(result.error||'호스트 실행 환경 연결 실패');return result;
  };
  await request('/open',{});
  const server=http.createServer((req,res)=>{res.writeHead(404);res.end();});
  const sockets=new WebSocketServer({noServer:true,maxPayload:MAX_FRAME}),key=randomUUID();
  let client,sequence=0,queuedBytes=0,sending=Promise.resolve(),streaming,closing;
  let acceptClient;
  const connected=new Promise((resolve,reject)=>{acceptClient=resolve;if(combined.aborted)reject(new Error('Execution bridge closed.'));else combined.addEventListener('abort',()=>reject(new Error('Execution bridge closed.')),{once:true});});
  connected.catch(()=>{});
  const fail=()=>{client?.terminate();controller.abort();};
  server.on('upgrade',(req,socket,head)=>{
    if(req.url!=='/'+key||req.headers.origin||client){socket.destroy();return;}
    sockets.handleUpgrade(req,socket,head,ws=>{
      client=ws;
      acceptClient();
      ws.on('message',(data,binary)=>{
        queuedBytes+=data.length;if(queuedBytes>MAX_BUFFER)return fail();
        sending=sending.then(()=>request('/send',{sequence:++sequence,...frame(data,binary)})).finally(()=>{queuedBytes-=data.length;});sending.catch(fail);
      });
      ws.on('close',()=>controller.abort());ws.on('error',fail);
    });
  });
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});}
  catch(error){fail();sockets.close();try{await fetch(host+route+'/close',{method:'POST',headers,body:JSON.stringify({lease:job.lease}),signal:AbortSignal.timeout(5000)});}catch{}throw error;}
  streaming=(async()=>{
    await connected;
    const res=await fetch(host+route+'/events',{method:'POST',headers,body:JSON.stringify({lease:job.lease}),signal:combined});
    if(!res.ok)throw new Error('호스트 실행 환경 스트림 연결 실패');
    const decoder=new TextDecoder();let pending='';
    for await(const bytes of res.body) {
      pending+=decoder.decode(bytes,{stream:true});if(pending.length>MAX_BUFFER)throw new Error('Execution stream too large.');
      let index;
      while((index=pending.indexOf('\n\n'))!==-1) {
        const event=pending.slice(0,index);pending=pending.slice(index+2);
        if(event.startsWith('event: closed'))throw new Error('Host execution environment closed.');
        const data=event.split('\n').find(l=>l.startsWith('data: '));if(!data)continue;
        const packet=JSON.parse(data.slice(6));
        if(!client||client.readyState!==WebSocket.OPEN)throw new Error('Local execution client disconnected.');
        if(client.bufferedAmount>MAX_BUFFER)throw new Error('Execution client is too slow.');
        await new Promise((resolve,reject)=>client.send(Buffer.from(packet.data,'base64'),{binary:packet.binary},error=>error?reject(error):resolve()));
      }
    }
    if(!controller.signal.aborted)fail();
  })();
  streaming.catch(fail);
  return {
    url:`ws://127.0.0.1:${server.address().port}/${key}`,
    close(){return closing||=(async()=>{
      fail();await Promise.allSettled([sending,streaming]);
      sockets.close();await new Promise(resolve=>server.close(resolve));
      try{await fetch(host+route+'/close',{method:'POST',headers,body:JSON.stringify({lease:job.lease}),signal:AbortSignal.timeout(5000)});}catch{}
    })();},
  };
}
