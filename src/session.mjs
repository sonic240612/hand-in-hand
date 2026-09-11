import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';

export const digest = text => createHash('sha256').update(text).digest('hex');
export const MAX_CHECKPOINT = 16 * 1024 * 1024;
const WRITER_CONFLICT = /^thread ([0-9a-f-]+) already has an active writer \(-32600\)$/;
export const LEGACY_COMPACTION_ERROR = '세션 압축이 감지되어 동일 기록 검증을 중지했습니다.';
export function inspectCheckpoint(text, expectedId = null, previous = '') {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_CHECKPOINT || !text.endsWith('\n')) throw new Error('Invalid or oversized session checkpoint.');
  if (previous && !text.startsWith(previous)) throw new Error('Session history was rewritten or omitted. Continuation rejected.');
  const records = text.trimEnd().split('\n').map(line => JSON.parse(line));
  const meta = records[0];
  if (meta?.type !== 'session_meta' || !meta.payload?.id) throw new Error('Missing native session metadata.');
  if (expectedId && meta.payload.id !== expectedId) throw new Error('Native session ID changed. Continuation rejected.');
  let compactions=0,windowId=meta.payload.context_window?.window_id,windowNumber=0;
  for(const record of records.slice(1)) {
    if(record.type==='session_meta') throw new Error('Multiple native session headers are not allowed.');
    if(record.type!=='compacted') continue;
    const p=record.payload;
    if(!p || typeof p.message!=='string' || !Array.isArray(p.replacement_history) || !p.replacement_history.length ||
      p.replacement_history.some(item=>!item || typeof item.type!=='string')) throw new Error('Incomplete native compaction checkpoint.');
    if(typeof p.window_id!=='string' || !p.window_id || p.window_id===windowId ||
      (windowId && p.previous_window_id!==windowId) || !Number.isInteger(p.window_number) || p.window_number<=windowNumber) throw new Error('Native compaction window chain is invalid.');
    windowId=p.window_id;windowNumber=p.window_number;compactions++;
  }
  return { nativeId: meta.payload.id, hash: digest(text), records: records.length, bytes: Buffer.byteLength(text), responseItems: records.filter(r => r.type === 'response_item').length,compactions,contextWindowId:windowId||null };
}

export function inspectInterruptedCompaction(checkpoint, previous, turn, nativeId) {
  const info=inspectCheckpoint(checkpoint,nativeId,previous);
  const suffix=checkpoint.slice(previous.length).trim().split('\n').filter(Boolean).map(JSON.parse);
  const started=suffix.filter(r=>r.type==='event_msg' && r.payload?.type==='task_started');
  const terminal=suffix.at(-1);
  if(started.length!==1 || !started[0].payload.turn_id || terminal?.type!=='event_msg' ||
    terminal.payload?.type!=='turn_aborted' || terminal.payload.turn_id!==started[0].payload.turn_id || terminal.payload.reason!=='interrupted') throw new Error('Interrupted compaction has no confirmed stop record.');
  const stopped=suffix.filter(r=>r.type==='event_msg' && r.payload?.type==='turn_aborted');
  if(stopped.length!==1) throw new Error('Interrupted compaction contains ambiguous stop records.');
  const allowedEvents=new Set(['task_started','turn_aborted','thread_settings_applied','token_count','context_compacted']);
  for(const r of suffix) {
    if(r.type==='event_msg' && allowedEvents.has(r.payload?.type)) continue;
    if(r.type==='event_msg' && r.payload?.type==='user_message' && typeof r.payload.message==='string' && r.payload.message.includes(turn.prompt)) continue;
    if(['compacted','token_usage_record','turn_context','world_state'].includes(r.type)) continue;
    if(r.type==='response_item' && r.payload?.type==='message') {
      if(['system','developer'].includes(r.payload.role)) continue;
      // Codex 0.154.0 can persist its own abort notice as a user message.
      // Bind this control record to the confirmed native turn, not just its text tag.
      const p=r.payload,m=p.internal_chat_message_metadata_passthrough;
      if(p.role==='user' && m?.turn_id===started[0].payload.turn_id &&
        m.content_item_kinds?.length===1 && m.content_item_kinds[0]==='generic.turn_aborted' &&
        p.content?.length===1 && p.content[0].type==='input_text' &&
        /^<turn_aborted>\n[^]*\n<\/turn_aborted>$/.test(p.content[0].text)) continue;
      if(r.payload.role==='user' && r.payload.content?.some(c=>typeof c.text==='string'&&c.text.includes(turn.prompt))) continue;
    }
    throw new Error(`Recovery contains model output or unverified activity (${r.type}/${r.payload?.type||'unknown'}/${r.payload?.role||'-'}); automatic recovery refused.`);
  }
  return info;
}

export class SessionStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'session.json');
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {
      schema: 1, id: randomUUID(), title: '우리의 첫 번째 프로젝트', createdAt: new Date().toISOString(),
      revision: 0, nativeId: null, checkpoint: '', checkpointHash: digest(''),
      turns: [], participants: [], invites: [], pairings: [], blocked: null,
    };
    let recovered = this.recoverWriterConflict();
    for (const turn of this.state.turns) {
      if (['running', 'syncing'].includes(turn.status)) {
        turn.status = 'interrupted'; turn.error = '호스트가 재시작되었습니다. 미확정 세션 복구가 필요합니다.';
        this.state.blocked = turn.error; recovered = true;
      }
    }
    if (!existsSync(this.file) || recovered) this.save();
  }
  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
  get active() { return this.state.turns.find(t => ['running', 'syncing'].includes(t.status)); }
  pendingCompactionRecovery(memberId) {
    const s=this.state,interrupted=s.turns.filter(t=>t.status==='interrupted');
    if(!s.blocked || this.active || interrupted.length!==1) return [];
    const turn=interrupted[0];
    return turn.authorId===memberId && turn.error===LEGACY_COMPACTION_ERROR && !turn.tools.length && !turn.items.length &&
      turn.baseRevision===s.revision && turn.baseHash===s.checkpointHash && turn.appliedRevision===s.revision &&
      turn.appliedHash===s.checkpointHash && turn.nativeId===s.nativeId ? [{id:turn.id,nativeId:s.nativeId}] : [];
  }
  recoverCompaction(memberId,turnId,checkpoint) {
    if(!this.pendingCompactionRecovery(memberId).some(t=>t.id===turnId)) throw new Error('이 계정에서 복구할 수 있는 압축 중단 기록이 없습니다.');
    const turn=this.state.turns.find(t=>t.id===turnId);
    const info=inspectCheckpoint(checkpoint,this.state.nativeId,this.state.checkpoint);
    try {inspectInterruptedCompaction(checkpoint,this.state.checkpoint,turn,this.state.nativeId);}
    catch(error) {
      // A valid append-only native log may still need review. Preserve it separately;
      // it must never become the active checkpoint merely because it was uploaded.
      const candidates=path.join(path.dirname(this.file),'recovery-candidates');mkdirSync(candidates,{recursive:true});
      const candidate=path.join(candidates,`${turn.id}-${info.hash}.jsonl`);
      if(!existsSync(candidate))writeFileSync(candidate,checkpoint,{mode:0o600,flag:'wx'});
      throw new Error(`${error.message} 복구 후보 원본을 호스트에 보관했습니다.`);
    }
    if(inspectCheckpoint(this.state.checkpoint,this.state.nativeId).hash!==this.state.checkpointHash) throw new Error('Host checkpoint checksum mismatch.');
    const dir=path.join(path.dirname(this.file),'recoveries');mkdirSync(dir,{recursive:true});
    const stamp=randomUUID();
    writeFileSync(path.join(dir,`${stamp}-before.json`),JSON.stringify(this.state),{mode:0o600,flag:'wx'});
    writeFileSync(path.join(dir,`${stamp}-native.jsonl`),checkpoint,{mode:0o600,flag:'wx'});
    // Keep the entire interrupted native log, including any completed compaction.
    Object.assign(this.state,{checkpoint,checkpointHash:info.hash,revision:this.state.revision+1,compactionCount:info.compactions,blocked:null});
    Object.assign(turn,{status:'failed',retryable:true,failurePhase:'compaction_interrupted',recoveredRevision:this.state.revision,recoveredAt:new Date().toISOString()});
    delete turn.lease;this.save();return info;
  }
  canRetryWriterConflict(turn, message) {
    const s=this.state;
    if(WRITER_CONFLICT.exec(message)?.[1]!==s.nativeId || !s.nativeId ||
      turn.baseRevision!==s.revision || turn.baseHash!==s.checkpointHash ||
      turn.appliedHash!==undefined || turn.appliedRevision!==undefined || turn.nativeId ||
      turn.committedRevision!==undefined || turn.tools.length || turn.items.length) return false;
    try { return inspectCheckpoint(s.checkpoint,s.nativeId).hash===s.checkpointHash; } catch { return false; }
  }
  recoverWriterConflict() {
    // Narrow migration for the old client: resume was rejected before /applied,
    // no model/tool activity occurred, and the committed checkpoint is intact.
    if(!this.state.blocked || this.state.turns.some(t=>['running','syncing'].includes(t.status))) return false;
    const interrupted=this.state.turns.filter(t=>t.status==='interrupted');
    if(interrupted.length!==1 || !this.canRetryWriterConflict(interrupted[0],interrupted[0].error)) return false;
    const backup=path.join(path.dirname(this.file),`before-writer-recovery-${randomUUID()}.json`);
    writeFileSync(backup,JSON.stringify(this.state),{mode:0o600,flag:'wx'});
    Object.assign(interrupted[0],{status:'failed',retryable:true,failurePhase:'resume_rejected'});
    this.state.blocked=null;
    return true;
  }
  retry(turn) {
    if(this.state.blocked || this.active || turn.status!=='failed' || !turn.retryable) throw new Error('이 작업은 안전하게 다시 실행할 수 없습니다.');
    // Re-submit at the end of the queue using the latest committed session.
    const next=this.enqueue({id:turn.authorId,name:turn.authorName},turn.prompt,`retry-${turn.id}`);
    turn.retriedAs=next.id;turn.retryable=false;this.save();return next;
  }
  enqueue(member, prompt, requestId) {
    if (this.state.blocked) throw new Error(this.state.blocked);
    if (!prompt?.trim() || prompt.length > 20_000) throw new Error('지시는 1~20,000자로 입력해 주세요.');
    if (!requestId || typeof requestId !== 'string' || requestId.length > 100) throw new Error('Invalid request ID.');
    const existing = this.state.turns.find(t => t.authorId === member.id && t.requestId === requestId);
    if (existing) return existing;
    const turn = { id: randomUUID(), requestId, authorId: member.id, authorName: member.name,
      prompt: prompt.trim(), status: 'queued', createdAt: new Date().toISOString(), items: [], tools: [] };
    this.state.turns.push(turn); this.save(); return turn;
  }
  claim(memberId, runnerId, account, accountFingerprint) {
    if (this.active || this.state.blocked) return null;
    const turn = this.state.turns.find(t => t.status === 'queued');
    if (!turn || turn.authorId !== memberId) return null;
    Object.assign(turn, { status: 'syncing', runnerId, account, accountFingerprint, startedAt: new Date().toISOString(),
      baseRevision: this.state.revision, baseHash: this.state.checkpointHash, lease: randomUUID() });
    this.save(); return turn;
  }
  complete(turn, { checkpoint, nativeId, status, error, model, usage }) {
    if (this.active?.id !== turn.id || turn.baseRevision !== this.state.revision || turn.baseHash !== this.state.checkpointHash) throw new Error('Stale turn cannot commit.');
    const info = inspectCheckpoint(checkpoint, this.state.nativeId || nativeId, this.state.checkpoint);
    if (info.nativeId !== nativeId) throw new Error('Native ID does not match the checkpoint.');
    const suffix = checkpoint.slice(this.state.checkpoint.length);
    const records = suffix.trim().split('\n').map(line => JSON.parse(line));
    const hasUser = records.some(r => r.type === 'response_item' && r.payload?.type === 'message' && r.payload.role === 'user' && r.payload.content?.some(c => typeof c.text === 'string' && c.text.includes(turn.prompt)));
    if (!hasUser) throw new Error('Current user instruction is missing from the checkpoint.');
    Object.assign(this.state, { nativeId, checkpoint, checkpointHash: info.hash, revision: this.state.revision + 1,compactionCount:info.compactions });
    Object.assign(turn, { status: status === 'completed' ? 'completed' : status === 'interrupted' ? 'cancelled' : 'failed', error: error || null,
      completedAt: new Date().toISOString(), committedRevision: this.state.revision, checkpointHash: info.hash,
      checkpointRecords: info.records, compactions:info.compactions,compacting:false, model, usage: usage || null });
    delete turn.lease;
    this.save(); return info;
  }
  fail(turn, message, failurePhase) {
    if(turn.status==='syncing' && failurePhase==='resume_rejected' && this.canRetryWriterConflict(turn,message)) {
      Object.assign(turn,{status:'failed',error:message,failurePhase,retryable:true,completedAt:new Date().toISOString()});
      delete turn.lease;this.save();return;
    }
    turn.status = 'interrupted'; turn.error = message; delete turn.lease;
    this.state.blocked = '세션 저장을 확인하지 못했습니다. 기록 손실을 막기 위해 다음 실행을 중지했습니다.';
    this.save();
  }
  publicState() {
    const s = this.state;
    return { id: s.id, title: s.title, revision: s.revision, nativeId: s.nativeId,
      checkpointHash: s.checkpointHash, checkpointBytes: Buffer.byteLength(s.checkpoint), compactionCount:s.compactionCount||0,blocked: s.blocked,
      createdAt: s.createdAt,
      participants: s.participants.filter(p => !p.revoked).map(({ id, name, role }) => ({ id, name, role })),
      turns: s.turns.map(({ lease, ...turn }) => turn) };
  }
}
