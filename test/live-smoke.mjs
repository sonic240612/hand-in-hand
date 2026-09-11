// Explicit opt-in: this test uses the locally signed-in Codex account for three short turns.
import { createHost } from '../src/server.mjs';
import { runAgent } from '../src/agent.mjs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const directory=path.resolve('.research',`live-${Date.now()}`);await mkdir(path.join(directory,'workspace'),{recursive:true});
await writeFile(path.join(directory,'workspace','receipt.json'),JSON.stringify({receipt:'host-only-7319'}));
const host=await createHost({port:0,dataDir:path.join(directory,'state'),workspace:path.join(directory,'workspace'),allowLocalAgent:false});
const controllers=[],agents=[];
const request=async(route,p,token)=>{const response=await fetch(host.url+route,{method:p===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`} : {})},body:p===undefined?undefined:JSON.stringify(p)});const data=await response.json();if(!response.ok)throw new Error(data.error);return data;};
try {
  const a=await request('/api/bootstrap',{name:'A'});const invite=await request('/api/invites',{},a.token);const b=await request('/api/join',{code:invite.code,name:'B'});
  for(const [name,member] of [['A',a],['B',b]]){
    const pairing=await request('/api/pairing',{},member.token),controller=new AbortController();controllers.push(controller);
    const ready=new Promise((resolve,reject)=>{const task=runAgent({host:host.url,pair:pairing.code,dataDir:path.join(directory,`agent-${name}`),signal:controller.signal,log:message=>console.log(name,message),onReady:resolve});agents.push(task);task.catch(reject);});await ready;
  }
  const prompts=[
    [a,"이 세션의 대화 전용 암호는 violet-orbit-542야. host_read_file로 receipt.json을 읽어서 영수증 값을 기억해. 암호와 영수증을 파일에 새로 쓰지는 말고, 짧게 확인만 해줘."],
    [b,"이전 사람이 말한 대화 전용 암호를 amber-orbit-914로 변경할게. 도구는 쓰지 말고, 이전 암호와 새 암호, 이전 도구 결과의 영수증 값을 세 항목으로 짧게 답해줘."],
    [a,"앞선 참여자가 변경한 현재 암호와 첫 도구 결과의 영수증을 result.json에 각각 passphrase, receipt로 저장해줘. 새 파일이고, 작성 후 host_validate_file로 검증해. 이전 취소된 암호를 쓰지 마."],
  ];
  let nativeId;
  for(const [i,[member,prompt]] of prompts.entries()){
    const {turn}=await request('/api/turns',{prompt,requestId:`smoke-${i}`},member.token);
    const start=Date.now();let result;
    while(Date.now()-start<180_000){const state=await request('/api/state',undefined,member.token);result=state.turns.find(t=>t.id===turn.id);if(['completed','failed','interrupted'].includes(result.status))break;await new Promise(r=>setTimeout(r,800));}
    assert.equal(result.status,'completed',result.error||'turn timeout');nativeId ||= result.nativeId;assert.equal(result.nativeId,nativeId);assert.equal(result.appliedRevision,i);assert.equal(result.committedRevision,i+1);
    console.log(`PASS turn ${i+1}: same native ID, v${i} → v${i+1}`,result.items.map(item=>item.text).join('\n'));
    if(i===1)for(const text of ['violet-orbit-542','amber-orbit-914','host-only-7319'])assert.ok(result.items.some(item=>item.text.includes(text)),`Missing ${text}`);
  }
  const output=JSON.parse(await readFile(path.join(directory,'workspace','result.json'),'utf8'));
  assert.deepEqual(output,{passphrase:'amber-orbit-914',receipt:'host-only-7319'});
  const state=await request('/api/state',undefined,a.token);assert.equal(state.revision,3);assert.equal(state.sameAccount,true);
  const report={passed:true,at:new Date().toISOString(),nativeId,revision:state.revision,checkpointHash:state.checkpointHash,sameAccount:true,distinctAccountBillingVerified:false,checks:['A→B→A independent runner processes','native session ID preserved','full checkpoint prefix preserved','conversation-only instruction recovered','tool result recovered','correction supersedes earlier instruction','host file write and JSON validation']};
  await writeFile(path.resolve('.research/live-report.json'),JSON.stringify(report,null,2));console.log('LIVE ACCEPTANCE PASSED. Two runners used the same local account; distinct-account billing remains unverified.');
}finally{controllers.forEach(c=>c.abort());await Promise.allSettled(agents);await host.close();}
