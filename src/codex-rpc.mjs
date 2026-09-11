import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

export function tomlValue(value) {
  if(typeof value==='string'||typeof value==='boolean'||typeof value==='number')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.filter(v=>v!==null&&v!==undefined).map(tomlValue).join(', ')+']';
  if(value&&typeof value==='object')return '{ '+Object.entries(value).filter(([,v])=>v!==null&&v!==undefined).map(([k,v])=>JSON.stringify(k)+' = '+tomlValue(v)).join(', ')+' }';
  throw new Error('Unsupported Codex configuration value.');
}

export class CodexRpc extends EventEmitter {
  constructor({ executable = process.env.HIH_CODEX_BIN || 'codex', cwd, env = process.env, config: overrides = {}, argsPrefix = [] } = {}) {
    super();
    this.nextId = 1;
    this.pending = new Map();
    const config = overrides;
    const args = [...argsPrefix, 'app-server', '--stdio'];
    for (const [key, value] of Object.entries(config)) {
      args.push('-c', `${key}=${tomlValue(value)}`);
    }
    this.child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.stderr = '';
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-4000); });
    createInterface({ input: this.child.stdout }).on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.method) {
        this.emit(msg.id !== undefined ? 'request' : 'notification', msg);
      } else {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        msg.error ? pending.reject(Object.assign(new Error(`${msg.error.message} (${msg.error.code})`), {code:msg.error.code, rpcMethod:pending.method})) : pending.resolve(msg.result);
      }
    });
    this.exited = new Promise(resolve => {
      this.child.once('exit', resolve);
      this.child.once('error', () => { if (!this.child.pid) { this.closed = true; resolve(); } });
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => {
      this.closed = true;
      this.fail(new Error(`Codex exited (${code ?? signal}). ${this.stderr}`));
      this.emit('closed');
    });
  }
  fail(error) {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
  }
  send(message) {
    if (this.closed || !this.child.stdin.writable) throw new Error('Codex connection closed.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}, timeout = 60_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex RPC timeout: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async initialize() {
    const result = await this.request('initialize', {
      clientInfo: { name: 'hand_in_hand', title: 'hand-in-hand', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized' });
    return result;
  }
  close() {
    return this.closing ||= this.stop();
  }
  async stop() {
    if (this.closed) return;
    // Don't let the next runner start while this process still holds its writer lock.
    this.child.stdin.end();
    let timer;
    try {
      await Promise.race([this.exited, new Promise(resolve => { timer=setTimeout(resolve,1500); })]);
    } finally { clearTimeout(timer); }
    if (!this.closed) {
      this.child.kill('SIGKILL');
      try {
        await Promise.race([this.exited, new Promise((_,reject) => { timer=setTimeout(()=>reject(new Error('Codex 프로세스 종료를 확인하지 못했습니다.')),5000); })]);
      } finally { clearTimeout(timer); }
    }
  }
}
