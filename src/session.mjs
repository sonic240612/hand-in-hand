import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';

export const digest = text => createHash('sha256').update(text).digest('hex');
export const MAX_CHECKPOINT = 16 * 1024 * 1024;
export function inspectCheckpoint(text, expectedId = null, previous = '') {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_CHECKPOINT || !text.endsWith('\n')) throw new Error('Invalid or oversized session checkpoint.');
  if (previous && !text.startsWith(previous)) throw new Error('Session history was rewritten or omitted. Continuation rejected.');
  const records = text.trimEnd().split('\n').map(line => JSON.parse(line));
  const meta = records[0];
  if (meta?.type !== 'session_meta' || !meta.payload?.id) throw new Error('Missing native session metadata.');
  if (expectedId && meta.payload.id !== expectedId) throw new Error('Native session ID changed. Continuation rejected.');
  if (records.some(record => record.type === 'compacted' || record.type === 'event_msg' && /compact/i.test(record.payload?.type || ''))) throw new Error('Compacted sessions are outside this prototype’s verified support.');
  return { nativeId: meta.payload.id, hash: digest(text), records: records.length, bytes: Buffer.byteLength(text), responseItems: records.filter(r => r.type === 'response_item').length };
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
    let recovered = false;
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
    Object.assign(this.state, { nativeId, checkpoint, checkpointHash: info.hash, revision: this.state.revision + 1 });
    Object.assign(turn, { status: status === 'completed' ? 'completed' : status === 'interrupted' ? 'cancelled' : 'failed', error: error || null,
      completedAt: new Date().toISOString(), committedRevision: this.state.revision, checkpointHash: info.hash,
      checkpointRecords: info.records, model, usage: usage || null });
    delete turn.lease;
    this.save(); return info;
  }
  fail(turn, message) {
    turn.status = 'interrupted'; turn.error = message; delete turn.lease;
    this.state.blocked = '세션 저장을 확인하지 못했습니다. 기록 손실을 막기 위해 다음 실행을 중지했습니다.';
    this.save();
  }
  publicState() {
    const s = this.state;
    return { id: s.id, title: s.title, revision: s.revision, nativeId: s.nativeId,
      checkpointHash: s.checkpointHash, checkpointBytes: Buffer.byteLength(s.checkpoint), blocked: s.blocked,
      createdAt: s.createdAt,
      participants: s.participants.filter(p => !p.revoked).map(({ id, name, role }) => ({ id, name, role })),
      turns: s.turns.map(({ lease, ...turn }) => turn) };
  }
}
