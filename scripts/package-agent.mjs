import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const files=[];
for(const name of ['agent.mjs','codex-rpc.mjs','codex-runtime.mjs','session.mjs','workspace.mjs','exec-transport.mjs','interactions.mjs','completion-receipts.mjs','connection-retry.mjs'])files.push(['src/'+name,await readFile(path.join(root,'src',name))]);
files.push(['scripts/doctor.mjs',await readFile(path.join(root,'scripts/doctor.mjs'))]);
files.push(['package.json',Buffer.from(JSON.stringify({...manifest,scripts:{agent:'node src/agent.mjs',doctor:'node scripts/doctor.mjs'}},null,2))]);
files.push(['package-lock.json',await readFile(path.join(root,'package-lock.json'))]);
files.push(['README.md',Buffer.from(`# hand-in-hand 연결기\n\nNode.js 22+, 공식 Codex CLI의 ChatGPT 로그인, Tailscale 연결이 필요합니다.\n\n\`npm ci\` 후 \`npm run doctor -- --host HOST_URL\`로 점검하세요.\n\`npm run agent -- --host HOST_URL\`로 시작하고 브라우저의 연결 코드를 입력하세요.\n재연결은 같은 폴더에서 \`npm run agent -- --host HOST_URL --resume\`을 실행합니다.\n\n업데이트할 때 연결기를 Ctrl+C로 중지하고 새 패키지의 코드를 덮어쓴 뒤 npm ci를 실행하세요.\n기존 .hih-agent 폴더와 별도로 지정한 --data 경로는 유지하세요.\n인증 파일이나 .hih-agent 폴더는 공유하지 마세요. API 키 로그인은 지원하지 않습니다.\n`)]);
// Portable ZIP with stored entries and an explicit source allowlist.
function crc32(buffer){let c=0xffffffff;for(const b of buffer){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
const entries=[],central=[];let offset=0;
for(const [relative,content]of files){
  const name=Buffer.from('hand-in-hand-agent/'+relative),crc=crc32(content),local=Buffer.alloc(30),directory=Buffer.alloc(46);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt32LE(crc,14);local.writeUInt32LE(content.length,18);local.writeUInt32LE(content.length,22);local.writeUInt16LE(name.length,26);
  directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x800,8);directory.writeUInt32LE(crc,16);directory.writeUInt32LE(content.length,20);directory.writeUInt32LE(content.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(offset,42);
  entries.push(local,name,content);central.push(directory,name);offset+=local.length+name.length+content.length;
}
const index=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(index.length,12);end.writeUInt32LE(offset,16);
await mkdir(path.join(root,'dist'),{recursive:true});const output=path.join(root,'dist/hand-in-hand-agent.zip');await writeFile(output,Buffer.concat([...entries,index,end]));console.log(output);
