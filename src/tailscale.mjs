import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync=promisify(execFile);
export async function tailscaleCommand(args) {
  const binary=process.env.HIH_TAILSCALE_BIN||'tailscale';
  return execFileAsync(binary,args,{windowsHide:true,timeout:15_000,maxBuffer:1024*1024});
}
const hostname=value=>typeof value==='string'?value.toLowerCase().replace(/\.$/,''):'';
function configFor(config,dns,port) {
  const configs=[config,...Object.values(config.Foreground||{})];
  const address=`${dns}:${port}`;
  return {
    occupied:configs.some(c=>c.TCP?.[port]||c.Web?.[address]),
    funnel:configs.some(c=>c.AllowFunnel?.[address]===true),
    ownedTarget:config.Web?.[address]?.Handlers?.['/']?.Proxy,
    onlyRoot:Object.keys(config.Web?.[address]?.Handlers||{}).length===1,
    https:config.TCP?.[port]?.HTTPS===true,
  };
}
function setupUrl(text) {
  return String(text).match(/https:\/\/login\.tailscale\.com\/[^\s<>"']+/)?.[0]||null;
}

// Manages only this app's single HTTPS Serve endpoint. Never calls Funnel or reset.
export class TailscaleAccess {
  constructor({dataDir,target,httpsPort=8443,execute=tailscaleCommand,onStatus=()=>{}}) {
    if(!Number.isInteger(httpsPort)||httpsPort<1||httpsPort>65535)throw new Error('Tailscale HTTPS 포트가 잘못되었습니다.');
    const local=new URL(target);
    if(local.protocol!=='http:'||local.hostname!=='127.0.0.1'||local.pathname!=='/')throw new Error('Tailscale 대상은 전용 loopback 서버여야 합니다.');
    this.target=local.origin;this.port=httpsPort;this.execute=execute;this.onStatus=onStatus;
    this.file=path.join(dataDir,'tailscale-access.json');this.busy=null;this.pendingError=null;
    this.state={mode:'tailscale',enabled:false,connected:false,installed:null,running:false,url:null,dnsName:null,port:httpsPort,error:null,setupUrl:null};
  }
  publish(values){Object.assign(this.state,values);this.onStatus({...this.state});return {...this.state};}
  async command(args){const result=await this.execute(args);return typeof result==='string'?result:result.stdout;}
  async inspect() {
    const status=JSON.parse(await this.command(['status','--json']));
    const dns=hostname(status.Self?.DNSName),running=status.BackendState==='Running'&&status.Self?.Online!==false;
    this.publish({installed:true,running,dnsName:dns||null,deviceName:status.Self?.HostName||dns.split('.')[0]||null});
    if(!running||!dns||!/^([a-z0-9-]+\.)+ts\.net$/.test(dns)) {
      this.publish({connected:false,url:null,error:running?'Tailscale 기기 주소를 확인할 수 없습니다.':'Tailscale 앱에서 로그인하고 연결을 켜 주세요.'});return null;
    }
    const config=JSON.parse(await this.command(['serve','status','--json'])),selected=configFor(config,dns,this.port);
    const url=`https://${dns}${this.port===443?'':':'+this.port}`;
    const connected=selected.https&&selected.ownedTarget===this.target&&!selected.funnel;
    if(connected)this.pendingError=null;
    this.publish({url,connected,enabled:selected.https&&selected.ownedTarget===this.target,
      error:selected.funnel?'이 포트는 인터넷 공개 설정(Funnel)이 켜져 있습니다. 사설 접속용 다른 포트를 선택하세요.':this.pendingError?.error||null,setupUrl:this.pendingError?.setupUrl||null});
    return {dns,selected};
  }
  failure(error) {
    const output=[error.message,error.stdout,error.stderr].filter(Boolean).join('\n');
    const missing=error.code==='ENOENT',denied=/access is denied|permission denied|액세스.*거부/i.test(output),setup=setupUrl(output);
    return this.publish({connected:false,installed:missing?false:this.state.installed,error:missing?'Tailscale을 설치한 뒤 다시 확인해 주세요.':setup?'Tailscale 관리 화면에서 HTTPS 사용을 허용한 뒤 다시 연결해 주세요.':denied?'Tailscale 서비스에 접근할 수 없습니다. 이 Windows 사용자의 Tailscale 권한을 확인하세요.':error.killed?'Tailscale 응답 시간이 초과되었습니다. 로그인·HTTPS 설정을 확인하세요.':String(error.message).slice(0,600),setupUrl:setup});
  }
  action(fn,persistError=false) {
    const operation=(this.busy||Promise.resolve()).then(fn).catch(error=>{this.failure(error);if(persistError)this.pendingError={error:this.state.error,setupUrl:this.state.setupUrl};return {...this.state};}).finally(()=>{if(this.busy===operation)this.busy=null;});
    this.busy=operation;return operation;
  }
  refresh(){return this.busy||this.action(()=>this.inspect().then(()=>({...this.state})));}
  enable(){return this.action(async()=>{
    this.pendingError=null;this.publish({error:null,setupUrl:null});
    const info=await this.inspect();if(!info)return {...this.state};
    const {dns,selected}=info;
    if(selected.funnel)throw new Error(this.state.error);
    let saved;try{saved=JSON.parse(await readFile(this.file,'utf8'));}catch{}
    const previousOwned=saved?.dns===dns&&saved?.port===this.port&&saved?.target===selected.ownedTarget&&selected.onlyRoot&&selected.https;
    if(selected.occupied&&!(selected.ownedTarget===this.target&&selected.https&&selected.onlyRoot)&&!previousOwned)throw new Error(`Tailscale의 ${this.port} 포트는 다른 서비스가 사용 중입니다. --tailscale-port로 다른 포트를 선택하세요.`);
    await this.command(['serve','--bg',`--https=${this.port}`,'--yes',this.target]);
    await writeFile(this.file,JSON.stringify({dns,port:this.port,target:this.target}),{mode:0o600});
    await this.inspect();if(!this.state.connected)throw new Error('Tailscale Serve 설정을 확인하지 못했습니다.');return {...this.state};
  },true);}
  disable(){return this.action(async()=>{
    const info=await this.inspect();if(!info)return {...this.state};
    const selected=info.selected;
    if(selected.ownedTarget!==this.target||!selected.onlyRoot||!selected.https||selected.funnel)throw new Error('Serve 설정이 변경되어 자동 해제를 중지했습니다. 기존 서비스를 확인하세요.');
    await this.command(['serve',`--https=${this.port}`,'off']);
    try{await unlink(this.file);}catch{}
    this.pendingError=null;return this.publish({enabled:false,connected:false,error:null,setupUrl:null});
  });}
  // A crash may leave Serve registered; the ownership record allows a safe restart.
  async close(){await this.busy;if(this.state.connected)await this.disable();}
}
