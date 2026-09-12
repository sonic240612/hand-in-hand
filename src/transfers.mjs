import { mkdir, readFile, writeFile, rename, stat, open, unlink, link, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './session.mjs';

export const MAX_UPLOAD=50*1024*1024, CHUNK_BYTES=512*1024;
export class Transfers {
  constructor(files,directory){this.files=files;this.directory=path.join(directory,'uploads');this.chain=Promise.resolve();}
  serial(fn){const pending=this.chain.then(fn);this.chain=pending.catch(()=>{});return pending;}
  async save(info){const dest=path.join(this.directory,info.id+'.json');await writeFile(dest+'.tmp',JSON.stringify(info),{mode:0o600});await rename(dest+'.tmp',dest);}
  async get(id,member){
    if(!/^[0-9a-f-]{36}$/.test(id))throw new Error('잘못된 전송 ID입니다.');
    const info=JSON.parse(await readFile(path.join(this.directory,id+'.json'),'utf8'));
    if(info.member!==member||info.expires<Date.now()||info.workspaceRoot!==this.files.root)throw new Error('전송 권한이 없거나 작업공간이 변경되었습니다. 파일을 다시 선택하세요.');return info;
  }
  async start(member,{name,size,hash}){
    const workspaceRoot=this.files.root;
    if(!Number.isInteger(size)||size<0||size>MAX_UPLOAD||!/^[a-f0-9]{64}$/.test(hash||''))throw new Error('파일은 50 MiB 이하이며 SHA-256 검증값이 필요합니다.');
    await this.files.resolve(name,true);await mkdir(this.directory,{recursive:true});
    if(this.files.root!==workspaceRoot)throw new Error('작업공간이 변경되었습니다. 파일을 다시 선택하세요.');
    const info={id:randomUUID(),member,workspaceRoot,name,size,hash,offset:0,expires:Date.now()+86400_000,status:'receiving'};
    await writeFile(path.join(this.directory,info.id+'.part'),Buffer.alloc(0),{flag:'wx',mode:0o600});await this.save(info);return info;
  }
  chunk(id,member,{offset,data}){return this.serial(async()=>{
    const info=await this.get(id,member);
    if(info.status!=='receiving'||!Number.isInteger(offset)||typeof data!=='string'||data.length>Math.ceil(CHUNK_BYTES/3)*4||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))throw new Error('잘못된 전송 조각입니다.');
    const bytes=Buffer.from(data,'base64');if(!bytes.length||bytes.length>CHUNK_BYTES||offset+bytes.length>info.size)throw new Error('전송 조각 크기가 잘못되었습니다.');
    const file=await open(path.join(this.directory,id+'.part'),'r+');
    try{
      if(offset<info.offset){const old=Buffer.alloc(bytes.length);await file.read(old,0,old.length,offset);if(offset+bytes.length>info.offset||!old.equals(bytes))throw new Error('이미 받은 조각과 다릅니다.');return info;}
      if(offset!==info.offset)throw new Error('전송 위치가 다릅니다. 상태를 확인한 뒤 이어서 보내세요.');
      await file.write(bytes,0,bytes.length,offset);await file.sync();info.offset+=bytes.length;await this.save(info);return info;
    }finally{await file.close();}
  });}
  finish(id,member){return this.serial(async()=>{
    const info=await this.get(id,member);if(info.status==='completed')return info;
    if(info.offset!==info.size)throw new Error('아직 전송이 끝나지 않았습니다.');
    const part=path.join(this.directory,id+'.part'),bytes=await readFile(part);
    if(bytes.length!==info.size||digest(bytes)!==info.hash)throw new Error('파일 원본 검증에 실패했습니다.');
    const target=await this.files.resolve(info.name,true);await mkdir(path.dirname(target),{recursive:true});await this.files.resolve(info.name,true);
    // Exclusive creation never overwrites an existing file, including after restart.
    if(info.status==='committing'){
      const existing=await readFile(target).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});
      if(existing&&digest(existing)===info.hash){info.status='completed';await this.save(info);await unlink(part).catch(()=>{});return info;}
      if(existing)throw new Error('동일 이름 파일이 있습니다. 다른 이름으로 전송하세요.');
    }
    // Detect conflicts before recording an intent, so an unrelated equal-content
    // file cannot be mistaken for a completed upload on retry.
    try{await stat(target);throw new Error('동일 이름 파일이 있습니다. 다른 이름으로 전송하세요.');}catch(e){if(e.code!=='ENOENT')throw e;}
    info.status='committing';await this.save(info);
    // Publish a fully received file atomically without replacing any existing
    // path. Staging next to the destination also supports a different data disk.
    const staging=path.join(path.dirname(target),`.hih-upload-${id}.tmp`);
    try{await writeFile(staging,bytes,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;if(!(await lstat(staging)).isFile()||(await lstat(staging)).isSymbolicLink()||digest(await readFile(staging))!==info.hash)throw new Error('임시 전송 파일을 확인할 수 없습니다.');}
    await this.files.resolve(info.name,true);await link(staging,target);
    info.status='completed';await this.save(info);await unlink(staging).catch(()=>{});await unlink(part).catch(()=>{});return info;
  });}
}
