import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),exec=promisify(execFile);
const run=(command,args)=>new Promise((resolve,reject)=>{const child=spawn(command,args,{cwd:root,stdio:'inherit',windowsHide:true});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`${command}: exit ${code}`)));});
try{
  const status=await exec('git',['status','--porcelain'],{cwd:root,windowsHide:true});
  if(status.stdout.trim())throw new Error('커밋되지 않은 변경이 있습니다. 먼저 보관하거나 커밋하세요. 자동으로 지우지 않습니다.');
  const args=process.argv.slice(2),data=args.includes('--data')?path.resolve(args[args.indexOf('--data')+1]):path.join(root,'.hih');
  let pid;try{pid=Number((await readFile(path.join(data,'host.lock'),'utf8')).trim());}catch(error){if(error.code!=='ENOENT')throw error;}
  if(pid){try{process.kill(pid,0);throw new Error('호스트를 먼저 종료하고 업데이트하세요.');}catch(error){if(error.code!=='ESRCH')throw error;}}
  console.log('연결기를 Ctrl+C로 중지한 상태에서 실행하세요. 로컬 데이터 폴더는 유지됩니다.');
  await run('git',['pull','--ff-only']);
  if(!process.env.npm_execpath)throw new Error('npm run update 명령으로 실행해 주세요.');
  await run(process.execPath,[process.env.npm_execpath,'ci']);
  console.log('업데이트 완료. 호스트 또는 기존 --resume 명령으로 연결기를 다시 시작하세요.');
}catch(error){console.error(error.message);process.exitCode=1;}
