import { readFile, mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';

// Read-only verification using the existing owner's credential. No invites or AI turns.
const args=process.argv.slice(2),get=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
const dataDir=path.resolve(get('--data','.hih')),local=get('--local','http://127.0.0.1:4317');
const token=(await readFile(path.join(dataDir,'owner-token'),'utf8')).trim();
const headers={Authorization:`Bearer ${token}`};
const call=async(base,route,auth=false)=>{const r=await fetch(base+route,{headers:auth?headers:{},signal:AbortSignal.timeout(15_000),redirect:'error'});return {status:r.status,data:await r.json()};};
const current=await call(local,'/api/state',true);assert.equal(current.status,200);
assert.equal(current.data.remoteAccess.mode,'tailscale');assert.equal(current.data.remoteAccess.connected,true,'Tailscale Serve is not ready.');
const remote=current.data.remoteAccess.url;assert.match(remote,/^https:\/\/[a-z0-9.-]+\.ts\.net(?::\d+)?$/);
assert.equal((await call(remote,'/api/health')).status,200);
assert.equal((await call(remote,'/api/state')).status,401);
assert.equal((await call(remote,'/api/files')).status,401);
const state=await call(remote,'/api/state',true);assert.equal(state.status,200);
assert.equal(state.data.id,current.data.id);assert.equal(state.data.nativeId,current.data.nativeId);assert.equal(state.data.checkpointHash,current.data.checkpointHash);
assert.equal(state.data.canLocalConnect,false);assert.equal(state.data.canManageNetwork,false);
assert.equal((await call(remote,'/api/files',true)).status,200);
const abort=new AbortController();let reader;
try {
  const stream=await fetch(remote+'/api/events',{headers,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(15_000)]),redirect:'error'});
  assert.equal(stream.status,200);assert.match(stream.headers.get('content-type'),/text\/event-stream/);
  reader=stream.body.getReader();let text='';while(!text.includes('\n\n')){const {value,done}=await reader.read();assert.equal(done,false);text+=new TextDecoder().decode(value);}
  const first=JSON.parse(text.match(/^data: (.+)$/m)[1]);assert.equal(first.id,current.data.id);assert.equal(first.nativeId,current.data.nativeId);
} finally {abort.abort();try{await reader?.cancel();}catch{}}
const report={passed:true,at:new Date().toISOString(),url:remote,nativeId:state.data.nativeId,revision:state.data.revision,checks:['HTTPS certificate verification','uninvited state/files rejected','authenticated same native session and checksum','remote local controls disabled','authenticated host file listing','SSE state across actual Serve'],differentDeviceVerified:false};
await mkdir('.research',{recursive:true});await writeFile('.research/tailscale-report.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
