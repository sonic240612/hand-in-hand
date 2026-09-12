import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { readChatgptTokens } from '../src/codex-runtime.mjs';
const exec=promisify(execFile),checks=[];
const check=(name,ok,detail)=>checks.push({name,ok,detail});
check('Node.js',Number(process.versions.node.split('.')[0])>=22,process.version);
try{const result=await exec(process.env.HIH_CODEX_BIN||'codex',['--version'],{windowsHide:true,timeout:10_000});check('Codex CLI',true,result.stdout.trim());}catch{check('Codex CLI',false,'공식 Codex CLI를 설치하거나 HIH_CODEX_BIN에 실행 파일 경로를 지정하세요.');}
try{await readChatgptTokens(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'));check('ChatGPT 로그인',true,'구독 로그인 확인 · 비밀값은 출력하지 않습니다.');}catch(error){check('ChatGPT 로그인',false,error.message);}
try{const result=await exec(process.env.HIH_TAILSCALE_BIN||'tailscale',['status','--json'],{windowsHide:true,timeout:10_000,maxBuffer:1024*1024});const status=JSON.parse(result.stdout);check('Tailscale',status.BackendState==='Running','상태: '+status.BackendState);}catch{check('Tailscale',false,'원격 협업 시 두 기기에 Tailscale 설치와 로그인이 필요합니다.');}
const args=process.argv.slice(2),host=args.includes('--host')?args[args.indexOf('--host')+1]:null;
if(host){try{const target=new URL(host);if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw new Error('invalid');const response=await fetch(new URL('/api/health',target),{signal:AbortSignal.timeout(10_000)});const health=await response.json();check('호스트 연결',response.ok&&health.ok===true,health.version?'hand-in-hand '+health.version:'응답 확인 실패');}catch{check('호스트 연결',false,'주소, 호스트 실행 상태, Tailscale 연결을 확인하세요.');}}
for(const result of checks)console.log(`${result.ok?'OK':'확인 필요'} · ${result.name}: ${result.detail}`);
console.log('AI 턴을 실행하지 않았으며 모델 사용량을 소비하지 않습니다.');
if(checks.some(c=>!c.ok))process.exitCode=1;
