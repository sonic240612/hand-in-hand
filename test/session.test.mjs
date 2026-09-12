import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
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
test('a summary, rewritten record, wrong native ID and incomplete compaction cannot replace original history',()=>{
  const original=meta+user('Original exact requirement');
  assert.throws(()=>inspectCheckpoint(meta+user('Summary only'),'native-shared-id',original),/rewritten|omitted/);
  assert.throws(()=>inspectCheckpoint(original,'another-id'),/ID changed/);
  assert.throws(()=>inspectCheckpoint(original+line({type:'compacted',payload:{message:'summary'}}),'native-shared-id',original),/Incomplete native compaction/);
  assert.throws(()=>inspectCheckpoint(original.slice(0,-1),'native-shared-id'),/Invalid/);
});
test('repeated submits are idempotent; crashed active turn blocks replay after restart',async t=>{
  const store=await setup(t),a={id:'a',name:'A'};
  const first=store.enqueue(a,'Write once','request');assert.equal(store.enqueue(a,'Write once','request').id,first.id);assert.equal(store.state.turns.length,1);
  store.claim('a','ra','account','fp');
  const restarted=new SessionStore(path.dirname(store.file));assert.equal(restarted.state.turns[0].status,'interrupted');assert.ok(restarted.state.blocked);
  assert.equal(restarted.enqueue(a,'Write once','request').id,first.id);assert.equal(restarted.state.turns.length,1);
  assert.equal(restarted.claim('a','ra','account','fp'),null);assert.throws(()=>restarted.enqueue(a,'Repeat','new'));
});
test('a submission bound to a previous session cannot enter the current session or resolve its request ID',async t=>{
  const store=await setup(t),a={id:'a',name:'A'},sessionId=store.state.id;
  const first=store.enqueue(a,'First project instruction','shared-request',sessionId);
  assert.equal(first.status,'queued');
  store.state.id='another-session';store.state.turns=[];store.save();
  const current=store.enqueue(a,'Current project instruction','shared-request',store.state.id);
  assert.throws(()=>store.enqueue(a,'First project instruction','new-request',sessionId),error=>error.status===409&&/세션이 변경/.test(error.message));
  assert.throws(()=>store.enqueue(a,current.prompt,'shared-request',sessionId),error=>error.status===409&&/세션이 변경/.test(error.message));
  assert.throws(()=>store.enqueue(a,'Invalid binding','null-request',null),error=>error.status===409);
  assert.deepEqual(store.state.turns.map(turn=>turn.id),[current.id]);
  assert.equal(new SessionStore(path.dirname(store.file)).state.turns.length,1);
});
test('one member cannot reuse a request ID for a different instruction, while different members can',async t=>{
  const store=await setup(t),a={id:'a',name:'A'},b={id:'b',name:'B'};
  const first=store.enqueue(a,'  Write once  ','same-id',store.state.id);
  assert.equal(store.enqueue(a,'Write once','same-id',store.state.id).id,first.id);
  assert.throws(()=>store.enqueue(a,'Write twice','same-id',store.state.id),error=>error.status===409&&/다른 지시/.test(error.message));
  const other=store.enqueue(b,'Write twice','same-id',store.state.id);
  assert.notEqual(other.id,first.id);assert.equal(store.state.turns.length,2);
  const restarted=new SessionStore(path.dirname(store.file));
  assert.equal(restarted.enqueue(a,'Write once','same-id',restarted.state.id).id,first.id);
  assert.throws(()=>restarted.enqueue(a,'Write twice','same-id',restarted.state.id),error=>error.status===409);
});
test('retransmitting the original submission after queued edits returns the edited turn without undoing changes',async t=>{
  const store=await setup(t),a={id:'a',name:'A'};
  const turn=store.enqueue(a,'Original instruction','request',store.state.id);
  turn.edits=[{prompt:turn.prompt,actor:a.name,at:new Date().toISOString()}];turn.prompt='Edited instruction';store.save();
  const restarted=new SessionStore(path.dirname(store.file));
  assert.equal(restarted.enqueue(a,'Original instruction','request',restarted.state.id).id,turn.id);
  assert.equal(restarted.state.turns[0].prompt,'Edited instruction');assert.equal(restarted.state.turns.length,1);
  assert.throws(()=>restarted.enqueue(a,'Edited instruction','request',restarted.state.id),error=>error.status===409);
  // Older persisted sessions have edit history but no explicit submission field.
  delete restarted.state.turns[0].submittedPrompt;restarted.save();
  const legacy=new SessionStore(path.dirname(store.file));
  assert.equal(legacy.enqueue(a,'Original instruction','request',legacy.state.id).id,turn.id);
  assert.throws(()=>legacy.enqueue(a,'Edited instruction','request',legacy.state.id),error=>error.status===409);
  assert.equal(legacy.state.turns[0].prompt,'Edited instruction');assert.equal(legacy.state.turns.length,1);
});
test('non-text submissions are rejected as validation errors without calling user-supplied trim',async t=>{
  const store=await setup(t),a={id:'a',name:'A'};
  for(const prompt of [null,undefined,{},[],42,true,{trim(){throw new Error('Unexpected trim call');}}]) {
    assert.throws(()=>store.enqueue(a,prompt,'request',store.state.id),/지시는 1~20,000자로/);
  }
  assert.equal(store.state.turns.length,0);
});
test('missing current user instruction cannot be committed',async t=>{
  const store=await setup(t),a={id:'a',name:'A'};store.enqueue(a,'Specific required instruction','a1');const turn=store.claim('a','ra','account','fp');
  assert.throws(()=>store.complete(turn,{checkpoint:meta+user('Different instruction'),nativeId:'native-shared-id',status:'completed'}),/instruction is missing/);
  assert.equal(store.state.revision,0);
});

async function writerFixture(t) {
  const store=await setup(t),member={id:'a',name:'A'};
  const first=store.enqueue(member,'Remember our original instruction','first');store.claim('a','runner','account','fp');
  store.complete(first,{checkpoint:meta+user(first.prompt)+assistant('Remembered.'),nativeId:'native-shared-id',status:'completed'});
  // Use a real UUID shape, as returned by Codex, for the error classifier.
  store.state.nativeId='11111111-1111-4111-8111-111111111111';
  store.state.checkpoint=store.state.checkpoint.replace('native-shared-id',store.state.nativeId);
  store.state.checkpointHash=digest(store.state.checkpoint);store.save();
  const turn=store.enqueue(member,'Continue without losing history','next');store.claim('a','runner','account','fp');
  return {store,turn,error:`thread ${store.state.nativeId} already has an active writer (-32600)`};
}

test('explicit writer rejection before resume completes can retry without changing committed history',async t=>{
  const {store,turn,error}=await writerFixture(t),before=store.state.checkpoint;
  store.fail(turn,error,'resume_rejected');
  assert.equal(store.state.blocked,null);assert.equal(turn.retryable,true);
  const next=store.retry(turn);assert.equal(next.prompt,turn.prompt);
  assert.equal(store.claim('a','new-runner','account','fp').id,next.id);
  assert.equal(next.baseHash,digest(before));assert.equal(store.state.revision,1);
  assert.equal(store.state.checkpoint,before);assert.throws(()=>store.retry(turn));
});

test('legacy writer rejection is backed up and recovered on restart only when no turn was applied',async t=>{
  const {store,turn,error}=await writerFixture(t);
  store.fail(turn,error);
  const before=await readFile(store.file,'utf8');
  const restored=new SessionStore(path.dirname(store.file));
  assert.equal(restored.state.blocked,null);assert.equal(restored.state.turns.at(-1).retryable,true);
  assert.equal(restored.state.checkpoint,store.state.checkpoint);
  const files=await readdir(path.dirname(store.file));const backups=files.filter(n=>n.startsWith('before-writer-recovery-'));
  assert.equal(backups.length,1);assert.equal(await readFile(path.join(path.dirname(store.file),backups[0]),'utf8'),before);
  new SessionStore(path.dirname(store.file));assert.equal((await readdir(path.dirname(store.file))).filter(n=>n.startsWith('before-writer-recovery-')).length,1);
});

test('writer text cannot unblock a started, changed, corrupt, or ambiguous session',async t=>{
  for(const mutate of [
    turn=>{turn.status='running';turn.appliedRevision=1;},
    turn=>{turn.tools.push({name:'host_write_file'});},
    turn=>{turn.items.push({text:'model output'});},
    turn=>{turn.baseHash='stale';},
    (turn,store)=>{store.state.checkpointHash='corrupt';},
    (turn,store)=>{store.state.turns.push({id:'unknown',status:'interrupted',error:'connection lost'});},
  ]) {
    const {store,turn,error}=await writerFixture(t);mutate(turn,store);
    store.fail(turn,error);const restarted=new SessionStore(path.dirname(store.file));
    assert.ok(restarted.state.blocked);assert.notEqual(restarted.state.turns.find(x=>x.id===turn.id).retryable,true);
  }
  const {store,turn}=await writerFixture(t);
  store.fail(turn,'Codex RPC timeout: thread/resume','resume_rejected');
  assert.ok(store.state.blocked);
});
