import test from 'node:test';
import assert from 'node:assert/strict';
import {ComposerJournal,BrowserCredentials} from '../public/client-state.js';
const storage=()=>{const data=new Map();return {getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};};
test('refresh retains the exact pending request while an acknowledgement preserves a newer draft',()=>{
  const disk=storage(),a=new ComposerJournal(disk,'session-a','member',()=> 'request-1');a.edit('Original instruction');const request=a.prepare();
  const refreshed=new ComposerJournal(disk,'session-a','member',()=> 'must-not-use');assert.deepEqual(refreshed.prepare(),request);
  refreshed.edit('A newer draft');assert.deepEqual(refreshed.prepare(),request);refreshed.acknowledge('request-1');assert.equal(refreshed.data.text,'A newer draft');assert.equal(refreshed.data.pending,null);
});
test('session and author switching never replays a pending instruction into another context',()=>{
  const disk=storage(),a=new ComposerJournal(disk,'session-a','member-a',()=> 'r');a.edit('Only project A');a.prepare();
  for(const [s,m] of [['session-b','member-a'],['session-a','member-b']])assert.deepEqual(new ComposerJournal(disk,s,m).data,{text:'',pending:null});
  const restored=new ComposerJournal(disk,'session-a','member-a');assert.equal(restored.reconcile([{authorId:'member-b',requestId:'r'}]),false);assert.equal(restored.reconcile([{authorId:'member-a',requestId:'r'}]),true);assert.equal(restored.data.text,'');
});
test('a request cannot be sent when its durable ID cannot be saved',()=>{
  const disk=storage(),journal=new ComposerJournal(disk,'s','m');journal.edit('important instruction');disk.setItem=()=>{throw new Error('quota');};assert.throws(()=>journal.prepare(),/quota/);assert.equal(journal.data.pending,null);
});
test('acknowledgement storage failure retains the original request ID instead of enabling duplicate submission',()=>{
  const disk=storage(),journal=new ComposerJournal(disk,'s','m',()=> 'original-request');journal.edit('Submit once');const request=journal.prepare();disk.setItem=()=>{throw new Error('quota');};
  assert.throws(()=>journal.acknowledge(request.requestId),/quota/);assert.deepEqual(journal.prepare(),request);assert.equal(journal.data.text,'Submit once');
});
test('device login is opt-in and forgetting it does not require or reveal another credential',()=>{
  const tab=storage(),device=storage(),credentials=new BrowserCredentials(tab,device);credentials.set('fixture-token');assert.equal(new BrowserCredentials(storage(),device).read(),null);
  credentials.set('fixture-token',true);assert.equal(new BrowserCredentials(storage(),device).read(),'fixture-token');credentials.set('fixture-token',false);assert.equal(device.getItem('hih-remembered-token'),null);assert.equal(credentials.read(),'fixture-token');credentials.clear();assert.equal(credentials.read(),null);
});
