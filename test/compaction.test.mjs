import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {SessionStore,digest,inspectCheckpoint,inspectInterruptedCompaction,LEGACY_COMPACTION_ERROR} from '../src/session.mjs';
import {nativeId,original,compact,interrupted,message,event,line,abortNotice} from './fixtures/native-session.mjs';

async function fixture(t) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'hih-compaction-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=new SessionStore(dir),member={id:'b',name:'B'};
  Object.assign(store.state,{checkpoint:original,checkpointHash:digest(original),nativeId,revision:4});store.save();
  const turn=store.enqueue(member,'What did the other participant say?','b1');store.claim('b','runner','B account','b-account');
  Object.assign(turn,{status:'running',appliedRevision:4,appliedHash:digest(original),nativeId});store.save();
  return {store,turn,dir,member};
}

test('native compaction preserves original bytes and validates consecutive context windows',()=>{
  const once=original+compact(),twice=once+compact({previous_window_id:'window-1',window_id:'window-2',window_number:2});
  assert.equal(inspectCheckpoint(twice,nativeId,once).compactions,2);
  assert.equal(inspectCheckpoint(twice,nativeId,once).contextWindowId,'window-2');
  assert.throws(()=>inspectCheckpoint(twice.replace('violet','amber'),nativeId,original),/rewritten/);
  for(const patch of [{previous_window_id:'unrelated'},{window_id:'window-0'},{window_number:0},{replacement_history:[]},{replacement_history:[null]}]) {
    assert.throws(()=>inspectCheckpoint(original+compact(patch),nativeId,original),/compaction/);
  }
  assert.throws(()=>inspectCheckpoint(once+compact({previous_window_id:'window-1',window_id:'window-2'}),nativeId,original),/window chain/);
  assert.throws(()=>inspectCheckpoint(once+line({type:'session_meta',payload:{id:nativeId}}),nativeId,original),/Multiple/);
});

test('a completed compacted turn is handed to the next participant with the same ID and full history',async t=>{
  const {store,turn}=await fixture(t),checkpoint=original+compact()+message('user',turn.prompt)+message('assistant','The violet project.');
  assert.throws(()=>store.complete(turn,{nativeId,checkpoint:original+compact(),status:'completed'}),/instruction is missing/);
  store.complete(turn,{nativeId,checkpoint,status:'completed'});
  assert.equal(store.state.blocked,null);assert.equal(store.publicState().compactionCount,1);
  store.enqueue({id:'a',name:'A'},'Continue','a1');const next=store.claim('a','other-runner','A account','a-account');
  assert.equal(next.baseHash,digest(checkpoint));assert.equal(next.baseRevision,5);
  assert.equal(store.state.nativeId,nativeId);assert.equal(store.state.checkpoint,checkpoint);
});

test('legacy interrupted compaction is backed up, kept in full, and retried only after recovery',async t=>{
  for(const middle of ['',compact(),message('user','What did the other participant say?'),abortNotice()]) {
    const {store,turn,dir,member}=await fixture(t),checkpoint=original+interrupted(middle);
    store.fail(turn,LEGACY_COMPACTION_ERROR);
    const before=await readFile(store.file,'utf8');
    assert.deepEqual(store.pendingCompactionRecovery('a'),[]);
    assert.throws(()=>store.recoverCompaction('a',turn.id,checkpoint));
    store.recoverCompaction(member.id,turn.id,checkpoint);
    assert.equal(store.state.checkpoint,checkpoint);assert.equal(store.state.revision,5);
    assert.equal(store.state.blocked,null);assert.equal(turn.retryable,true);
    const backups=await readdir(path.join(dir,'recoveries'));
    assert.equal(await readFile(path.join(dir,'recoveries',backups.find(n=>n.endsWith('-before.json'))),'utf8'),before);
    assert.equal(await readFile(path.join(dir,'recoveries',backups.find(n=>n.endsWith('-native.jsonl'))),'utf8'),checkpoint);
    assert.throws(()=>store.recoverCompaction(member.id,turn.id,checkpoint));
    const restored=new SessionStore(dir);assert.equal(restored.state.blocked,null);assert.equal(restored.state.checkpoint,checkpoint);
    const retry=store.retry(turn);assert.equal(retry.authorId,member.id);assert.equal(retry.prompt,turn.prompt);
    assert.equal(store.claim(member.id,'updated-runner','B account','b-account').baseHash,digest(checkpoint));
  }
});

test('recovery refuses output, tools, different instructions, missing stops, or a rewritten prefix without changing state',async t=>{
  const {store,turn,dir}=await fixture(t);store.fail(turn,LEGACY_COMPACTION_ERROR);
  const before=await readFile(store.file,'utf8');
  for(const checkpoint of [
    original,
    original+event('task_started',{turn_id:'native-turn'}),
    original+interrupted(message('assistant','May have acted.')),
    original+interrupted(line({type:'response_item',payload:{type:'function_call',name:'host_write_file'}})),
    original+interrupted(message('user','An unrelated instruction')),
    original+interrupted(abortNotice({internal_chat_message_metadata_passthrough:{turn_id:'wrong-turn',content_item_kinds:['generic.turn_aborted']}})),
    original+interrupted(abortNotice({internal_chat_message_metadata_passthrough:{turn_id:'native-turn',content_item_kinds:['user']}})),
    original+interrupted(abortNotice({content:[{type:'input_text',text:'An unrelated instruction'}]})),
    original+interrupted(event('user_message',{message:'An unrelated instruction'})),
    original+interrupted(event('task_started',{turn_id:'another-turn'})),
    original+interrupted(event('turn_aborted',{turn_id:'another-turn',reason:'interrupted'})),
    original+interrupted(event('unexpected_model_activity')),
    original+interrupted().replace('"reason":"interrupted"','"reason":"unknown"'),
    original.replace('violet','changed')+interrupted(),
  ]) {
    assert.throws(()=>store.recoverCompaction('b',turn.id,checkpoint));
    assert.equal(await readFile(store.file,'utf8'),before);assert.ok(store.state.blocked);
  }
  assert.ok(!(await readdir(dir)).includes('recoveries'));
  const candidates=await readdir(path.join(dir,'recovery-candidates'));
  assert.ok(candidates.length>0);
  for(const name of candidates)assert.ok((await readFile(path.join(dir,'recovery-candidates',name),'utf8')).startsWith(original));
  assert.throws(()=>inspectInterruptedCompaction(original+interrupted(),original,turn,'different-id'),/ID changed/);
});

test('legacy recovery stays blocked when host activity, applied version, checksum, or pending state is uncertain',async t=>{
  for(const mutate of [
    turn=>turn.tools.push({name:'host_write_file'}),
    turn=>turn.items.push({text:'output'}),
    turn=>{turn.baseHash='stale';},
    turn=>{turn.appliedRevision=3;},
    turn=>{turn.nativeId='wrong';},
    (turn,store)=>{store.state.checkpoint=original.replace('violet','changed');},
    (turn,store)=>{store.state.turns.push({id:'other',status:'interrupted'});},
  ]) {
    const {store,turn}=await fixture(t);store.fail(turn,LEGACY_COMPACTION_ERROR);mutate(turn,store);store.save();
    assert.throws(()=>store.recoverCompaction('b',turn.id,original+interrupted()));assert.ok(store.state.blocked);
  }
});
