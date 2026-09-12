import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { digest } from './session.mjs';

// An outbox is written only after Codex reports turn completion and the writer
// and host execution connection have closed. Partial rollouts use the existing
// review path; they never masquerade as completed receipts.
export async function saveReceipt(dataDir,turnId,payload){
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(turnId))throw new Error('Invalid receipt turn ID.');
  const directory=path.join(dataDir,'receipts');await mkdir(directory,{recursive:true});
  const file=path.join(directory,turnId+'.json'),record={turnId,payload,hash:digest(payload.checkpoint)};
  await writeFile(file+'.tmp',JSON.stringify(record),{mode:0o600});await rename(file+'.tmp',file);return record;
}
export async function flushReceipts(dataDir,api,log=()=>{}){
  const directory=path.join(dataDir,'receipts');let names;
  try{names=await readdir(directory);}catch(error){if(error.code==='ENOENT')return;throw error;}
  for(const name of names.filter(n=>/^[A-Za-z0-9_-]{1,128}\.json$/.test(n)).sort()){
    const file=path.join(directory,name),record=JSON.parse(await readFile(file,'utf8'));
    if(name!==record.turnId+'.json'||digest(record.payload.checkpoint)!==record.hash)throw new Error('저장 대기 중인 세션 원본 검증에 실패했습니다.');
    await api('/api/worker/receipt',record);await unlink(file);log('완료된 턴의 저장을 확인했습니다. 같은 작업을 다시 실행하지 않습니다.');
  }
}
export async function removeReceipt(dataDir,turnId){await unlink(path.join(dataDir,'receipts',turnId+'.json'));}
