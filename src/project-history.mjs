import { mkdir, readFile, writeFile, rename, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './session.mjs';

// Workspace backups are separate from the native conversation. Restoring a file
// never rewinds the Codex thread or changes a previously committed tool result.
export class ProjectHistory {
  constructor(files, directory) { this.files=files; this.directory=path.join(directory,'file-history'); }
  async saveJson(name, value) {
    await mkdir(this.directory,{recursive:true});
    const target=path.join(this.directory,name),temp=target+'.'+randomUUID()+'.tmp';
    await writeFile(temp,JSON.stringify(value),{mode:0o600});await rename(temp,target);
  }
  async snapshot() {
    const entries={},skipped=[];let bytes=0;
    const listing=await this.files.list(2001);
    if(listing.length>2000)throw new Error('변경 이력은 최대 2,000개 파일까지 지원합니다. 생성 파일은 공유 폴더 밖으로 옮겨 주세요.');
    await mkdir(path.join(this.directory,'blobs'),{recursive:true});
    for(const file of listing) {
      if(file.bytes>2*1024*1024||bytes+file.bytes>32*1024*1024){skipped.push(file.path);continue;}
      try {
        const buffer=await readFile(await this.files.resolve(file.path));
        if(buffer.length>2*1024*1024||bytes+buffer.length>32*1024*1024){skipped.push(file.path);continue;}
        bytes+=buffer.length;const hash=digest(buffer);
        try{await writeFile(path.join(this.directory,'blobs',hash),buffer,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
        entries[file.path]={hash,bytes:buffer.length,mode:(await lstat(await this.files.resolve(file.path))).mode&0o777};
      }catch(error){if(error.code==='ENOENT'){skipped.push(file.path);continue;}throw error;}
    }
    return {entries,skipped,at:new Date().toISOString()};
  }
  async begin(id) { const before=await this.snapshot();await this.saveJson(id+'.json',{id,before});return {skipped:before.skipped}; }
  async load(id) {
    if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('잘못된 변경 기록입니다.');
    return JSON.parse(await readFile(path.join(this.directory,id+'.json'),'utf8'));
  }
  async finish(id) {
    const record=await this.load(id);if(record.after)return record;
    record.after=await this.snapshot();const skipped=new Set([...record.before.skipped,...record.after.skipped]);
    record.changes=[...new Set([...Object.keys(record.before.entries),...Object.keys(record.after.entries)])].filter(name=>!skipped.has(name)).flatMap(name=>{
      const before=record.before.entries[name]||null,after=record.after.entries[name]||null;
      return before?.hash===after?.hash?[]:[{path:name,before,after,kind:!before?'added':!after?'deleted':'modified'}];
    });
    record.skipped=[...skipped];await this.saveJson(id+'.json',record);return record;
  }
  async detail(id) {
    const record=await this.load(id);
    const decode=async entry=>{
      if(!entry)return null;
      if(entry.bytes>256_000)return {binary:true,bytes:entry.bytes};
      const buffer=await readFile(path.join(this.directory,'blobs',entry.hash));
      return buffer.includes(0)?{binary:true,bytes:buffer.length}:{content:buffer.toString('utf8')};
    };
    return {id,at:record.after?.at,skipped:record.skipped||record.before.skipped,changes:await Promise.all((record.changes||[]).map(async c=>({...c,beforeView:await decode(c.before),afterView:await decode(c.after)})))};
  }
  async restore(id,name,actor) {
    const record=await this.load(id),change=record.changes?.find(c=>c.path===name);
    if(!change)throw new Error('복구할 파일 변경이 없습니다.');
    const file=await this.files.resolve(name,true);
    let current=null;
    try{if(!(await lstat(file)).isFile())throw new Error('일반 파일만 복구할 수 있습니다.');current=await readFile(file);}catch(e){if(e.code!=='ENOENT')throw e;}
    if((current===null?null:digest(current))!==(change.after?.hash||null))throw new Error('이후 파일 변경과 충돌합니다. 최신 내용과 비교해 주세요.');
    // Persist the recovery intent before touching the workspace, including the
    // expected current hash. A crash never silently retries a file operation.
    const recovery={id:randomUUID(),source:id,path:name,actor,at:new Date().toISOString(),before:change.after,after:change.before,status:'pending'};
    await this.saveJson('restore-'+recovery.id+'.json',recovery);
    if(change.before){
      const buffer=await readFile(path.join(this.directory,'blobs',change.before.hash));
      if(digest(buffer)!==change.before.hash)throw new Error('백업 파일 검증에 실패했습니다.');
      await mkdir(path.dirname(file),{recursive:true});await this.files.resolve(name,true);
      // Re-check after asynchronous backup reads. External editors are not locked.
      let latest=null;try{latest=digest(await readFile(file));}catch(e){if(e.code!=='ENOENT')throw e;}
      if(latest!==(change.after?.hash||null))throw new Error('복구 중 파일이 바뀌었습니다.');
      await writeFile(file,buffer,{flag:current===null?'wx':'w',mode:change.before.mode??0o644});
    } else {
      await this.files.resolve(name);
      if(digest(await readFile(file))!==change.after.hash)throw new Error('복구 중 파일이 바뀌었습니다.');
      await unlink(file);
    }
    recovery.status='completed';await this.saveJson('restore-'+recovery.id+'.json',recovery);return recovery;
  }
}
