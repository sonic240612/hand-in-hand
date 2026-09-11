import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHost } from '../src/server.mjs';
import { TailscaleAccess } from '../src/tailscale.mjs';

const dns='host.test-tailnet.ts.net';
function cliFixture(initial={}) {
  const fake={config:structuredClone(initial),calls:[],target:null,running:true};
  fake.execute=async args=>{
    fake.calls.push(args);
    if(args[0]==='status')return {stdout:JSON.stringify({BackendState:fake.running?'Running':'NeedsLogin',Self:{DNSName:dns+'.',Online:fake.running}})};
    if(args.join(' ')==='serve status --json')return {stdout:JSON.stringify(fake.config)};
    const port=args.find(x=>x.startsWith('--https='))?.split('=')[1];assert.ok(port);assert.equal(args[0],'serve');
    if(args.at(-1)==='off'){delete fake.config.TCP?.[port];delete fake.config.Web?.[`${dns}:${port}`];return {stdout:''};}
    fake.target=args.at(-1);fake.config.TCP||={};fake.config.Web||={};fake.config.TCP[port]={HTTPS:true};fake.config.Web[`${dns}:${port}`]={Handlers:{'/':{Proxy:fake.target}}};return {stdout:'Available within your tailnet'};
  };
  return fake;
}
async function temp(t){const dir=await mkdtemp(path.join(os.tmpdir(),'hih-tailscale-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
const call=(url,route,data,token,headers={})=>new Promise((resolve,reject)=>{
  const req=http.request(url+route,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`} : {}),...headers}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>{try{resolve({status:res.statusCode,data:JSON.parse(text)});}catch(error){reject(error);}});});
  req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('HTTP test timed out')));req.end(data===undefined?undefined:JSON.stringify(data));
});

test('Tailscale setup preserves other services, advertises the private URL, and cleans up only its endpoint',async t=>{
  const dir=await temp(t),other={TCP:{443:{HTTPS:true}},Web:{[`${dns}:443`]:{Handlers:{'/':{Proxy:'http://127.0.0.1:9000'}}}}},fake=cliFixture(other);
  const access=new TailscaleAccess({dataDir:dir,target:'http://127.0.0.1:5555',execute:fake.execute});
  assert.equal((await access.refresh()).connected,false);
  const result=await access.enable();assert.equal(result.connected,true);assert.equal(result.url,`https://${dns}:8443`);
  assert.deepEqual(fake.config.Web[`${dns}:443`],other.Web[`${dns}:443`]);
  await access.close();assert.deepEqual(fake.config,other);
  assert.ok(fake.calls.every(args=>!args.includes('funnel')&&!args.includes('reset')));
});

test('conflicting or public Funnel configurations are refused, while an owned stale target can restart',async t=>{
  const dir=await temp(t),target='http://127.0.0.1:5555';
  for(const cfg of [
    {TCP:{8443:{HTTPS:true}},Web:{[`${dns}:8443`]:{Handlers:{'/':{Proxy:'http://127.0.0.1:9999'}}}}},
    {TCP:{8443:{HTTPS:true}},Web:{[`${dns}:8443`]:{Handlers:{'/':{Proxy:target}}}},AllowFunnel:{[`${dns}:8443`]:true}},
    {Foreground:{other:{TCP:{8443:{HTTPS:true}}}}},
  ]) {
    const fake=cliFixture(cfg),access=new TailscaleAccess({dataDir:dir,target,execute:fake.execute});
    assert.equal((await access.enable()).connected,false);assert.ok(access.state.error);assert.deepEqual(fake.config,cfg);
    assert.ok(fake.calls.every(args=>!args.includes('--bg')));
  }
  const fake=cliFixture(),first=new TailscaleAccess({dataDir:dir,target,execute:fake.execute});await first.enable();
  const restarted=new TailscaleAccess({dataDir:dir,target:'http://127.0.0.1:6666',execute:fake.execute});
  assert.equal((await restarted.enable()).connected,true);assert.equal(fake.target,'http://127.0.0.1:6666');await restarted.close();
});

test('missing installation, login, permissions and HTTPS setup are reported without issuing network changes',async t=>{
  const dir=await temp(t),target='http://127.0.0.1:5555';
  for(const [error,pattern] of [
    [Object.assign(new Error('not found'),{code:'ENOENT'}),/설치/],
    [new Error('Access is denied'),/권한/],
    [Object.assign(new Error('Enable HTTPS'),{stderr:'Visit https://login.tailscale.com/admin/dns to enable HTTPS'}),/HTTPS/],
  ]) {
    const access=new TailscaleAccess({dataDir:dir,target,execute:async()=>{throw error;}});
    const result=await access.enable();assert.equal(result.connected,false);assert.match(result.error,pattern);
    if(error.stderr)assert.equal(result.setupUrl,'https://login.tailscale.com/admin/dns');
  }
  const fake=cliFixture();fake.running=false;
  const access=new TailscaleAccess({dataDir:dir,target,execute:fake.execute});assert.equal((await access.enable()).running,false);
  assert.ok(fake.calls.every(args=>args[0]==='status'));
});

test('Serve proxy requests cannot bootstrap owners or manage the host; invited users reach the same session',async t=>{
  const dir=await temp(t),root=path.join(dir,'workspace');await mkdir(root);await writeFile(path.join(root,'index.html'),'<html>shared</html>');
  const fake=cliFixture(),host=await createHost({port:0,dataDir:path.join(dir,'state'),workspace:root,allowLocalAgent:false,tailscale:{execute:fake.execute}});
  t.after(()=>host.close());
  const owner=(await call(host.url,'/api/bootstrap',{})).data;
  assert.equal((await call(host.url,'/api/invites',{},owner.token)).status,409);
  assert.equal((await call(host.url,'/api/network/tailscale/enable',{},owner.token)).status,200);
  const headers={Host:`${dns}:8443`,'Tailscale-User-Login':'guest@example.test',Origin:`https://${dns}:8443`};
  const uninvited=await call(fake.target,'/api/state',undefined,undefined,headers);assert.equal(uninvited.status,401,JSON.stringify(uninvited.data));
  assert.equal((await call(fake.target,'/api/bootstrap',{},undefined,headers)).status,403);
  assert.equal((await call(fake.target,'/api/network/tailscale/disable',{},owner.token,headers)).status,403);
  assert.equal((await call(fake.target,'/api/local-agent',{},owner.token,headers)).status,403);
  assert.equal((await call(fake.target,'/api/state',undefined,owner.token,{Host:headers.Host})).status,403);
  assert.equal((await call(fake.target,'/api/state',undefined,owner.token,{...headers,Origin:'https://untrusted.example'})).status,403);
  const invite=(await call(host.url,'/api/invites',{},owner.token)).data;assert.equal(invite.url,`https://${dns}:8443`);assert.equal(invite.mode,'tailscale');
  const guest=(await call(fake.target,'/api/join',{name:'B',code:invite.code},undefined,headers)).data;
  const state=(await call(fake.target,'/api/state',undefined,guest.token,headers)).data;
  assert.equal(state.id,host.store.state.id);assert.equal(state.canManageNetwork,false);assert.equal(state.canLocalConnect,false);
  assert.equal((await call(fake.target,'/api/file?path=index.html',undefined,guest.token,headers)).data.content,'<html>shared</html>');
  await call(host.url,`/api/members/${guest.member.id}/revoke`,{},owner.token);
  assert.equal((await call(fake.target,'/api/state',undefined,guest.token,headers)).status,401);
  assert.equal((await call(host.url,'/api/network/tailscale/disable',{},owner.token)).status,200);
  assert.equal((await call(host.url,'/api/invites',{},owner.token)).status,409);
});

test('HTTPS setup guidance survives status polling and enable is not dropped during a refresh',async t=>{
  const dir=await temp(t),fake=cliFixture();
  const access=new TailscaleAccess({dataDir:dir,target:'http://127.0.0.1:5555',execute:async args=>{
    if(args.includes('--bg'))throw Object.assign(new Error('HTTPS not enabled'),{stderr:'Enable at https://login.tailscale.com/admin/dns'});
    return fake.execute(args);
  }});
  const refresh=access.refresh(),enable=access.enable();await refresh;await enable;
  assert.equal(access.state.setupUrl,'https://login.tailscale.com/admin/dns');
  await access.refresh();assert.match(access.state.error,/HTTPS/);assert.equal(access.state.setupUrl,'https://login.tailscale.com/admin/dns');
});
