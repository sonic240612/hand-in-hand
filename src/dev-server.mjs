import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { digest } from './session.mjs';
const exec=promisify(execFile);
const initialState=()=>({status:'stopped',log:'',script:null,port:null});
async function terminateTree(child,force=false){
  if(process.platform==='win32')await exec(path.join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:10_000});
  else try{process.kill(-child.pid,force?'SIGKILL':'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}
}
function processGroupExists(pid){if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(-pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;if(error.code==='EPERM')return true;throw error;}}

export class DevServer {
  constructor({workspace,dataDir,onChange=()=>{},spawnProcess=spawn,killTree=terminateTree,groupExists=process.platform==='win32'?null:processGroupExists,stopGraceMs=5000}){
    this.workspace=workspace;this.file=path.join(dataDir,'dev-server.json');this.onChange=onChange;this.spawn=spawnProcess;this.killTree=killTree;this.groupExists=groupExists;this.stopGraceMs=stopGraceMs;
    this.state=initialState();this.child=null;this.closedChildren=new WeakSet();this.chain=Promise.resolve();this.saves=Promise.resolve();this.saveError=null;
  }
  async initialize(){
    try{const saved=JSON.parse(await readFile(this.file,'utf8'));this.state={...saved,pid:null,status:['starting','running','stopping'].includes(saved.status)?'interrupted':saved.status};if(this.state.status==='interrupted')this.state.error='호스트가 종료되었습니다. 실행 상태를 확인한 뒤 다시 시작하세요. 자동으로 명령을 재실행하지 않았습니다.';}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  publish(patch){Object.assign(this.state,patch);const state={...this.state};this.onChange(state);this.saves=this.saves.then(async()=>{await mkdir(path.dirname(this.file),{recursive:true});await writeFile(this.file+'.tmp',JSON.stringify(state),{mode:0o600});await rename(this.file+'.tmp',this.file);this.saveError=null;}).catch(error=>{this.saveError=error;this.state.error='서버 상태 저장 실패: '+error.message;});return this.publicState();}
  publicState(){return {...this.state};}
  async scripts(){
    try{const raw=await readFile(await this.workspace.resolve('package.json'),'utf8'),manifest=JSON.parse(raw);
      return {hash:digest(raw),scripts:Object.entries(manifest.scripts||{}).filter(([name,command])=>/^[A-Za-z0-9:_-]{1,80}$/.test(name)&&typeof command==='string').map(([name,command])=>({name,command}))};
    }catch(error){if(error.code==='ENOENT')return {hash:null,scripts:[]};throw error;}
  }
  serial(fn){const next=this.chain.then(fn);this.chain=next.catch(()=>{});return next;}
  reset(){return this.serial(async()=>{
    if(this.child)throw new Error('개발 서버를 먼저 중지하세요.');
    this.state=initialState();this.publish({});await this.saves;
    if(this.saveError)throw new Error('이전 작업공간의 실행 기록을 초기화하지 못했습니다: '+this.saveError.message);
    return this.publicState();
  });}
  start({script,expectedHash,port}){return this.serial(async()=>{
    if(this.child)throw new Error('실행 중인 개발 서버를 먼저 중지하세요.');
    if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('개발 서버 포트를 확인하세요.');
    const catalog=await this.scripts(),selected=catalog.scripts.find(s=>s.name===script);
    if(!selected||catalog.hash!==expectedHash)throw new Error('package.json이 변경되었습니다. 실행할 스크립트를 다시 확인하세요.');
    await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(new Error('해당 포트는 이미 사용 중입니다. 실행 중인 서버를 확인하세요.')));probe.listen(port,'127.0.0.1',()=>probe.close(resolve));});
    // Only a reviewed npm script name enters the shell command on Windows.
    // The actual project command remains npm's responsibility, as in a terminal.
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>! /^(?:CODEX_|OPENAI_|ANTHROPIC_|HIH_)/i.test(key)));
    const windows=process.platform==='win32',program=windows?path.join(process.env.SystemRoot||'C:\\Windows','System32','cmd.exe'):'npm';
    const args=windows?['/d','/s','/c',`chcp 65001 >nul && npm run ${script}`]:['run',script];
    const child=this.spawn(program,args,{cwd:this.workspace.root,env,windowsHide:true,detached:!windows,stdio:['ignore','pipe','pipe']});this.child=child;
    let ended;this.ended=new Promise(resolve=>{ended=resolve;});
    this.publish({status:'starting',script,command:selected.command,port,pid:child.pid||null,startedAt:new Date().toISOString(),endedAt:null,exitCode:null,error:null,log:''});
    let logTimer;const append=data=>{this.state.log=(this.state.log+data.toString('utf8')).slice(-64_000);if(!logTimer)logTimer=setTimeout(()=>{logTimer=null;this.publish({});},200);};
    for(const stream of [child.stdout,child.stderr]){const decoder=new StringDecoder('utf8');stream.on('data',data=>append(decoder.write(data)));stream.once('end',()=>append(decoder.end()));}
    child.once('spawn',()=>this.publish({status:'running',pid:child.pid}));
    child.once('error',error=>this.publish({status:'failed',error:error.message}));
    child.once('close',(code,signal)=>{
      clearTimeout(logTimer);this.closedChildren.add(child);
      // A detached Unix child's process group can outlive npm. Keep its handle
      // available for Stop until this particular spawned group is gone.
      let groupAlive=false,groupError;
      try{groupAlive=!!this.groupExists?.(child.pid);}catch(error){groupAlive=true;groupError=error.message;}
      if(this.child===child&&!groupAlive)this.child=null;
      const stopping=this.state.status==='stopping';
      this.publish({status:groupAlive?(stopping?'stopping':'running'):stopping?'stopped':code===0?'stopped':'failed',pid:groupAlive?child.pid:null,exitCode:code,signal,endedAt:groupAlive?null:new Date().toISOString(),...(groupAlive&&!stopping?{error:groupError||'상위 프로세스가 종료되었지만 하위 프로세스가 남아 있습니다. 중지를 눌러 종료하세요.'}:{})});ended();
    });
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});return this.publicState();
  });}
  stop(){return this.serial(async()=>{
    const child=this.child;if(!child)return this.publicState();this.publish({status:'stopping',error:null});
    try{
      try{await this.killTree(child);}catch(error){if(this.child===child)throw error;}
      const gone=()=>this.closedChildren.has(child)&&!this.groupExists?.(child.pid);
      const wait=async milliseconds=>{const deadline=Date.now()+milliseconds;while(!gone()){const remaining=deadline-Date.now();if(remaining<=0)return false;await new Promise(resolve=>setTimeout(resolve,Math.min(50,remaining)));}return true;};
      const done=await wait(this.stopGraceMs);
      if(!done&&this.groupExists)await this.killTree(child,true);
      if(!done&&!await wait(3000))throw new Error('개발 서버 종료를 확인하지 못했습니다.');
      if(this.child===child)this.child=null;
      this.publish({status:'stopped',pid:null,error:null,endedAt:this.state.endedAt||new Date().toISOString()});
      return this.publicState();
    }catch(error){this.publish({status:this.child===child?'running':'stopped',error:'개발 서버 종료 실패: '+error.message});throw error;}
  });}
  async close(){await this.stop();await this.saves;}
}
