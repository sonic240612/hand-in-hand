import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const destination=path.resolve(process.argv[2]||'.hih/relay.key');
await mkdir(path.dirname(destination),{recursive:true});
try{await writeFile(destination,randomBytes(32).toString('base64url')+'\n',{flag:'wx',mode:0o600});console.log(`중계 키 파일을 만들었습니다: ${destination}\n이 파일은 호스트와 중계 서버 관리자만 보관하세요. 초대받는 참여자에게는 전달하지 않습니다.`);}catch(error){if(error.code==='EEXIST')console.error('기존 중계 키를 덮어쓰지 않았습니다.');else throw error;process.exitCode=1;}
