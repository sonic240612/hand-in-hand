import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { DevServer } from '../src/dev-server.mjs';
import { Workspace } from '../src/workspace.mjs';

async function setup(t,options={}){
  const root=await mkdtemp(path.join(os.tmpdir(),'hih-dev-state-'));
  const server=new DevServer({workspace:new Workspace(root),dataDir:root,...options});
  t.after(async()=>{if(server.child)server.child.emit('close',0);await server.close();await rm(root,{recursive:true,force:true});});
  return {root,server};
}

test('workspace reset removes all previous script output and metadata from memory and disk',async t=>{
  const {root,server}=await setup(t);
  server.publish({status:'failed',script:'old-project',port:4321,log:'private previous project output',command:'node private-project.mjs',pid:null,error:'old error'});
  await server.reset();
  const expected={status:'stopped',log:'',script:null,port:null};
  assert.deepEqual(server.publicState(),expected);
  assert.deepEqual(JSON.parse(await readFile(path.join(root,'dev-server.json'),'utf8')),expected);
  const restarted=new DevServer({workspace:new Workspace(root),dataDir:root});await restarted.initialize();
  assert.equal(restarted.publicState().log,'');assert.equal(restarted.publicState().command,undefined);
});

test('a failed process stop keeps the stop action retryable and prevents workspace reset',async t=>{
  const child=new EventEmitter();child.pid=123;child.stdout=new PassThrough();child.stderr=new PassThrough();let attempts=0;
  const {root,server}=await setup(t,{
    spawnProcess:()=>{queueMicrotask(()=>child.emit('spawn'));return child;},
    killTree:async()=>{if(++attempts===1)throw new Error('termination denied');child.emit('close',0);},
  });
  await writeFile(path.join(root,'package.json'),JSON.stringify({scripts:{dev:'node dev.mjs'}}));
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const catalog=await server.scripts();await server.start({script:'dev',expectedHash:catalog.hash,port});
  await assert.rejects(server.stop(),/termination denied/);
  assert.equal(server.publicState().status,'running');assert.match(server.publicState().error,/termination denied/);assert.equal(server.child,child);
  await assert.rejects(server.reset(),/먼저 중지/);
  assert.equal((await server.stop()).status,'stopped');assert.equal(attempts,2);assert.equal(server.child,null);
  await server.reset();assert.equal(server.publicState().error,undefined);
});

// Injected process-group checks exercise Unix lifecycle decisions on every OS.
// These tests do not claim to run a real Unix process group on Windows.
for(const parentExitedFirst of [false,true])test(`remaining owned process group is stopped after npm closes (${parentExitedFirst?'parent already exited':'parent exits during stop'})`,async t=>{
  const child=new EventEmitter();child.pid=246;child.stdout=new PassThrough();child.stderr=new PassThrough();let groupAlive=true;const signals=[];
  const {root,server}=await setup(t,{
    spawnProcess:()=>{queueMicrotask(()=>child.emit('spawn'));return child;},
    groupExists:pid=>{assert.equal(pid,child.pid);return groupAlive;},stopGraceMs:10,
    killTree:async(target,force=false)=>{assert.equal(target,child);signals.push(force);if(force)groupAlive=false;else if(!parentExitedFirst)child.emit('close',0);},
  });
  await writeFile(path.join(root,'package.json'),JSON.stringify({scripts:{dev:'node dev.mjs'}}));
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const catalog=await server.scripts();await server.start({script:'dev',expectedHash:catalog.hash,port});
  if(parentExitedFirst){child.emit('close',0);assert.equal(server.child,child);assert.equal(server.publicState().status,'running');await assert.rejects(server.reset(),/먼저 중지/);}
  assert.equal((await server.stop()).status,'stopped');assert.deepEqual(signals,[false,true]);assert.equal(groupAlive,false);assert.equal(server.child,null);
});
