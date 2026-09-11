import { readdir, lstat, readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digest } from './session.mjs';
const executeFile = promisify(execFile);
const denied = new Set(['.git', '.codex', '.hih', '.hih-agent', '.ssh', 'node_modules']);
export class Workspace {
  constructor(root) { this.root = path.resolve(root); }
  async resolve(name, create = false) {
    if (typeof name !== 'string' || !name || name.length > 400 || /[\x00-\x1f:]/.test(name) || path.isAbsolute(name)) throw new Error('프로젝트 안의 상대 경로만 사용할 수 있습니다.');
    const parts = name.replaceAll('\\', '/').split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || denied.has(p.toLowerCase()) || /^\.env(?:\.|$)/i.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p) || /\.(pem|key|pfx|p12)$/i.test(p))) throw new Error('공유하지 않는 경로입니다.');
    const root = await realpath(this.root);
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) throw new Error('링크·junction 경로는 지원하지 않습니다.');
        const actual = await realpath(current);
        const rel = path.relative(root, actual);
        if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('워크스페이스 바깥 경로입니다.');
      } catch (error) { if (error.code !== 'ENOENT' || !create) throw error; }
    }
    return current;
  }
  async list() {
    const files = [];
    const walk = async (directory, prefix = '', depth = 0) => {
      if (depth > 5 || files.length >= 200) return;
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const name = prefix + item.name;
        if (item.name.startsWith('.') || denied.has(item.name.toLowerCase()) || item.isSymbolicLink()) continue;
        try { await this.resolve(name); } catch { continue; }
        if (item.isDirectory()) await walk(path.join(directory, item.name), name + '/', depth + 1);
        else if (files.length < 200) files.push({ path: name, bytes: (await lstat(path.join(directory, item.name))).size });
      }
    };
    await walk(this.root); return files.sort((a,b) => a.path.localeCompare(b.path));
  }
  async read(name) {
    const file = await this.resolve(name);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > 256_000) throw new Error('이 프로토타입은 256KB 이하 텍스트 파일을 지원합니다.');
    const buffer = await readFile(file);
    if (buffer.includes(0)) throw new Error('바이너리 파일은 지원하지 않습니다.');
    const content = buffer.toString('utf8');
    return { path: name, content, hash: digest(content), bytes: buffer.length };
  }
  async write({ path: name, content, expectedHash }) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > 256_000) throw new Error('파일 크기 제한은 256KB입니다.');
    if (typeof expectedHash !== 'string') throw new Error('수정 전 파일 hash가 필요합니다. 새 파일은 빈 문자열을 사용하세요.');
    let before = '';
    let exists = true;
    try { before = (await this.read(name)).content; } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
    if ((exists ? digest(before) : '') !== expectedHash) throw new Error('파일 버전 충돌: 최신 파일을 다시 읽은 뒤 수정하세요.');
    const file = await this.resolve(name, true);
    await mkdir(path.dirname(file), { recursive: true });
    // Check again after creating parents; never follow a newly introduced link.
    await this.resolve(name, true);
    if (exists) { if ((await this.read(name)).hash !== expectedHash) throw new Error('파일이 변경되었습니다.'); }
    await writeFile(file, content, { flag: exists ? 'w' : 'wx' });
    return { path: name, hash: digest(content), bytes: Buffer.byteLength(content), before, after: content };
  }
  async validate(name) {
    const { content, hash } = await this.read(name);
    const file = await this.resolve(name);
    if (/\.(mjs|cjs|js)$/i.test(name)) {
      try { const r = await executeFile(process.execPath, ['--check', file], { timeout: 10_000, windowsHide: true, env: {} }); return { path: name, hash, ok: true, check: 'node --check', output: r.stdout || 'JavaScript syntax OK' }; }
      catch (e) { return { path: name, hash, ok: false, check: 'node --check', output: String(e.stderr || e.message).slice(0,8000) }; }
    }
    if (/\.json$/i.test(name)) { try { JSON.parse(content); return { path:name,hash,ok:true,check:'JSON parse' }; } catch(e) { return {path:name,hash,ok:false,check:'JSON parse',output:e.message}; } }
    if (/\.html?$/i.test(name)) return { path:name,hash,ok:/<html[\s>]/i.test(content) && /<\/html>/i.test(content),check:'HTML document boundary check (not browser or semantic validation)' };
    return { path:name,hash,ok:true,check:'UTF-8 text readable only; no execution performed' };
  }
  async tool(name,args) {
    if (name === 'host_list_files') return { files: await this.list() };
    if (name === 'host_read_file') return this.read(args.path);
    if (name === 'host_write_file') return this.write(args);
    if (name === 'host_validate_file') return this.validate(args.path);
    throw new Error('지원하지 않는 호스트 도구입니다.');
  }
}
const spec = (name,description,properties,required=Object.keys(properties)) => ({type:'function',name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
export const HOST_TOOLS = [
  spec('host_list_files','List files in the authoritative shared host workspace. No project files exist on your local runner.',{}),
  spec('host_read_file','Read a host text file. Returns the exact content and hash needed for editing.',{path:{type:'string'}}),
  spec('host_write_file','Write a host text file using optimistic version checking. Read existing files first. For NEW files use expectedHash="". Returns exact before and after content.',{path:{type:'string'},content:{type:'string'},expectedHash:{type:'string'}}),
  spec('host_validate_file','Validate a host file: JS syntax with node --check, JSON parsing, or basic HTML document boundary check. Does not run arbitrary shell commands.',{path:{type:'string'}}),
];
