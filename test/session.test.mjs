import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionStore, digest, inspectCheckpoint } from '../src/session.mjs';
const line=value=>JSON.stringify(value)+'\n';
const meta=line({type:'session_meta',payload:{id:'native-shared-id'}});
const user=prompt=>line({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:prompt}]}});
const assistant=text=>line({type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text}]}});
async function setup(t){const dir=await mkdtemp(path.join(os.tmpdir(),'hih-session-'));t.after(()=>rm(dir,{recursive:true,force:true}));return new SessionStore(dir);}
test('A → B → A preserves native ID, original instructions, tool call/output, correction and FIFO',async t=>{
  const store=await setup(t),a={id:'a',name:'A'},b={id:'b',name:'B'};
  const first=store.enqueue(a,'Use amber.\nReceipt required.','a1');
  store.enqueue(b,'Correction: use violet, keep the receipt.','b1');
  store.enqueue(a,'What color and receipt did we agree on?','a2');
  assert.equal(store.claim('b','rb','B account','b-fp'),null);
  assert.equal(store.claim('a','ra','A account','a-fp').id,first.id);
  assert.equal(store.claim('b','rb','B account','b-fp'),null);
  let checkpoint=meta+user(first.prompt)+line({type:'response_item',payload:{type:'function_call',name:'host_receipt',arguments:'{}',call_id:'tool1'}})+line({type:'response_item',payload:{type:'function_call_output',call_id:'tool1',output:'receipt-7319'}})+assistant('Amber is set.');
  store.complete(first,{checkpoint,nativeId:'native-shared-id',status:'completed'});
  const second=store.claim('b','rb','B account','b-fp');assert.equal(second.baseHash,digest(checkpoint));assert.equal(second.baseRevision,1);
  checkpoint+=user(second.prompt)+assistant('Violet is now the color.');store.complete(second,{checkpoint,nativeId:'native-shared-id',status:'completed'});
  const third=store.claim('a','ra','A account','a-fp');assert.equal(third.baseHash,digest(checkpoint));assert.equal(third.baseRevision,2);
  checkpoint+=user(third.prompt)+assistant('Violet, receipt-7319.');store.complete(third,{checkpoint,nativeId:'native-shared-id',status:'completed'});
  assert.equal(store.state.nativeId,'native-shared-id');assert.equal(store.state.revision,3);
  assert.ok(store.state.checkpoint.includes('receipt-7319'));assert.ok(store.state.checkpoint.includes('Correction: use violet'));
  assert.deepEqual(store.state.turns.map(t=>t.account),['A account','B account','A account']);
});
test('a summary, rewritten record, wrong native ID and native compaction cannot replace original history',()=>{
  const original=meta+user('Original exact requirement');
  assert.throws(()=>inspectCheckpoint(meta+user('Summary only'),'native-shared-id',original),/rewritten|omitted/);
  assert.throws(()=>inspectCheckpoint(original,'another-id'),/ID changed/);
  assert.throws(()=>inspectCheckpoint(original+line({type:'compacted',payload:{message:'summary'}}),'native-shared-id',original),/Compacted/);
  assert.throws(()=>inspectCheckpoint(original.slice(0,-1),'native-shared-id'),/Invalid/);
});
test('repeated submits are idempotent; crashed active turn blocks replay after restart',async t=>{
  const store=await setup(t),a={id:'a',name:'A'};
  const first=store.enqueue(a,'Write once','request');assert.equal(store.enqueue(a,'Write once','request').id,first.id);assert.equal(store.state.turns.length,1);
  store.claim('a','ra','account','fp');
  const restarted=new SessionStore(path.dirname(store.file));assert.equal(restarted.state.turns[0].status,'interrupted');assert.ok(restarted.state.blocked);
  assert.equal(restarted.claim('a','ra','account','fp'),null);assert.throws(()=>restarted.enqueue(a,'Repeat','new'));
});
test('missing current user instruction cannot be committed',async t=>{
  const store=await setup(t),a={id:'a',name:'A'};store.enqueue(a,'Specific required instruction','a1');const turn=store.claim('a','ra','account','fp');
  assert.throws(()=>store.complete(turn,{checkpoint:meta+user('Different instruction'),nativeId:'native-shared-id',status:'completed'}),/instruction is missing/);
  assert.equal(store.state.revision,0);
});
