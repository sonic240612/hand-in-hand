import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

export class CodexRpc extends EventEmitter {
  constructor({ executable = process.env.HIH_CODEX_BIN || 'codex', cwd, env = process.env } = {}) {
    super();
    this.nextId = 1;
    this.pending = new Map();
    const config = {
      'features.shell_tool': false,
      'features.unified_exec': false,
      'features.apply_patch_freeform': false,
      'features.apps': false,
      'features.plugins': false,
      'features.shell_snapshot': false,
      'features.multi_agent': false,
      'web_search': 'disabled',
      'mcp_servers': {},
    };
    const args = ['app-server', '--stdio'];
    for (const [key, value] of Object.entries(config)) {
      args.push('-c', `${key}=${JSON.stringify(value)}`);
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
        msg.error ? pending.reject(new Error(`${msg.error.message} (${msg.error.code})`)) : pending.resolve(msg.result);
      }
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
      this.pending.set(id, { resolve, reject, timer });
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
  async close() {
    if (this.closed) return;
    this.child.stdin.end();
    await Promise.race([new Promise(resolve => this.child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 1500))]);
    if (!this.closed) this.child.kill();
  }
}
