import { projectFeatures } from './project-ui.js';
const $=id=>document.getElementById(id);
const e=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let credential=sessionStorage.getItem('hih-token'),state,me,canLocalConnect=false,canManageNetwork=false,streamController;
let previewHash='',fileStamp='',selectedFile=null,lastFilesRefresh=0,turnsStamp='';
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10_000);}
const features=projectFeatures({api,modal,toast,escape:e,getState:()=>state,getMe:()=>me,refreshFiles,refreshPreview,download});
const partial=new Map();
const statusLabels={queued:'차례 대기',syncing:'동일 세션 적용 중',running:'작업 중',completed:'완료',failed:'실패',interrupted:'확인 필요',cancelled:'취소됨'};
let toastTimer;
function toast(message){$('toast').textContent=message;$('toast').classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.add('hidden'),4500);}
async function api(route,body){const res=await fetch(route,{method:body===undefined?'GET':'POST',headers:{...(credential?{Authorization:`Bearer ${credential}`} : {}),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await res.json();if(!res.ok)throw new Error(data.error||'연결에 실패했습니다.');return data;}
function modal(html){$('modal-body').innerHTML=html;if(!$('modal').open)$('modal').showModal();}
$('close-modal').onclick=()=>$('modal').close();
$('modal').addEventListener('click',event=>{if(event.target===$('modal'))$('modal').close();});
function avatar(memberId){const i=Math.max(0,state?.participants.findIndex(p=>p.id===memberId)??0);return `color-${i%3}`;}
const interactionLabels={approval:'명령·파일 작업 승인',permissions:'호스트 접근 권한 승인',questions:'Codex 질문',elicitation:'연결 도구 확인'};
function renderInteractions(turn){return (turn.interactions||[]).filter(i=>i.status==='pending').map(i=>`<div class="interaction-card"><strong>${e(interactionLabels[i.kind]||'Codex 확인')}</strong><p>${i.actorId===me.id?'응답하면 작업을 계속합니다.':e(state.participants.find(p=>p.id===i.actorId)?.name||'참여자')+'의 응답을 기다리고 있습니다.'}</p>${i.actorId===me.id?`<button class="button primary" data-interaction="${e(i.id)}">내용 확인 · 응답</button>`:''}</div>`).join('');}
function elicitationField(key,f,required){
  const attrs=`data-form-key="${e(key)}" ${required?'required':''}`,type=f.type,complex=!['string','number','integer','boolean'].includes(type);
  const input=f.enum?`<select ${attrs} data-value-kind="enum">${f.enum.map(v=>`<option value="${e(JSON.stringify(v))}" ${v===f.default?'selected':''}>${e(v)}</option>`).join('')}</select>`:
    complex?`<textarea ${attrs} data-value-kind="json" placeholder="JSON 형식으로 입력">${e(f.default===undefined?'':JSON.stringify(f.default,null,2))}</textarea>`:
    `<input ${attrs} type="${type==='boolean'?'checkbox':['number','integer'].includes(type)?'number':f.format==='password'?'password':'text'}" ${type==='boolean'?(f.default?'checked':''):`value="${e(f.default??'')}"`} ${type==='number'?'step="any"':''}>`;
  return `<label class="question-field"><strong>${e(f.title||key)}</strong><p>${e(f.description||'')}</p>${input}</label>`;
}
async function openInteraction(id){
  try{
    const request=await api('/api/interactions/'+encodeURIComponent(id)),p=request.params;
    let body='',actions='';
    if(request.kind==='questions'){
      body=(p.questions||[]).map(q=>`<label class="question-field"><strong>${e(q.header||'')}</strong><p>${e(q.question)}</p>${q.options?.length?`<select data-answer-select="${e(q.id)}"><option value="">직접 입력</option>${q.options.map(o=>`<option value="${e(o.label)}">${e(o.label)}${o.description?' — '+e(o.description):''}</option>`).join('')}</select>`:''}<textarea data-answer="${e(q.id)}" placeholder="답변을 입력하세요"></textarea></label>`).join('');
      actions='<button class="button primary" data-answer-action="answer">답변 보내기</button>';
    }else if(request.kind==='elicitation'){
      const url=typeof p.url==='string'&&/^https?:\/\//i.test(p.url)?p.url:null;
      body=`<p>${e(p.message||p.serverName+' 도구가 확인을 요청했습니다.')}</p>${url?`<a class="button" href="${e(url)}" target="_blank" rel="noopener noreferrer">연결 도구 페이지 열기 ↗</a>`:''}`;
      const properties=p.requestedSchema?.properties||{};
      body+=Object.entries(properties).map(([key,f])=>elicitationField(key,f,(p.requestedSchema.required||[]).includes(key)&&f.type!=='boolean')).join('');
      actions='<button class="button" data-answer-action="decline">거절</button><button class="button primary" data-answer-action="accept">확인</button>';
    }else{
      const item=state.turns.flatMap(t=>t.tools).find(t=>t.nativeItemId===p.itemId)?.args;
      body=`<p>${e(p.reason||'Codex가 다음 작업을 진행하려고 합니다.')}</p><pre class="approval-preview">${e(p.command||JSON.stringify(p.permissions||item?.changes||p,null,2))}</pre>${p.cwd?`<p class="muted">작업 위치: ${e(p.cwd)}</p>`:''}`;
      actions='<button class="button" data-answer-action="decline">거절</button><button class="button primary" data-answer-action="accept">이번 요청 허용</button>';
      if(p.availableDecisions?.includes('acceptForSession'))actions+='<button class="button" data-answer-action="acceptForSession">세션 동안 허용</button>';
    }
    modal(`<h2>${e(interactionLabels[request.kind])}</h2>${body}<div class="modal-actions">${actions}</div>`);
    document.querySelectorAll('[data-answer-action]').forEach(button=>button.onclick=async()=>{
      try {
      const reply={action:button.dataset.answerAction};
      if(request.kind==='questions')reply.answers=Object.fromEntries((p.questions||[]).map(q=>{
        const text=[...document.querySelectorAll('[data-answer]')].find(f=>f.dataset.answer===q.id)?.value;
        const selected=[...document.querySelectorAll('[data-answer-select]')].find(f=>f.dataset.answerSelect===q.id)?.value;
        return [q.id,[text?.trim()||selected||'']];
      }));
      if(request.kind==='elicitation'&&p.requestedSchema&&reply.action==='accept')reply.content=Object.fromEntries([...document.querySelectorAll('[data-form-key]')].flatMap(f=>{
        if(!f.reportValidity())throw new Error('입력 내용을 확인하세요.');
        const type=p.requestedSchema.properties[f.dataset.formKey].type;
        if(!f.required&&!f.value&&type!=='boolean')return [];
        const value=f.dataset.valueKind?JSON.parse(f.value):type==='boolean'?f.checked:['number','integer'].includes(type)?Number(f.value):f.value;
        return [[f.dataset.formKey,value]];
      }));
      button.disabled=true;
      await api('/api/interactions/'+encodeURIComponent(id),reply);$('modal').close();toast('응답을 전달했습니다.');}catch(error){button.disabled=false;toast(error.message);}
    });
  }catch(error){toast(error.message);}
}
function render(next){
  state=next;
  $('session-title').textContent=state.title;$('heading').textContent=state.title;$('workspace-name').textContent=state.workspaceName||'workspace';
  $('member-count').textContent=state.participants.length;$('turn-count').textContent=`${state.turns.length}개의 턴`;
  $('my-name').textContent=me?.name||'나';$('my-avatar').textContent=(me?.name||'나').slice(0,1);$('my-role').textContent=me?.role==='owner'?'호스트':me?.role==='observer'?'관찰자':'참여자';
  $('connect').classList.toggle('hidden',me?.role==='observer');$('composer').classList.toggle('hidden',me?.role==='observer');
  document.querySelectorAll('.invite-trigger').forEach(b=>b.classList.toggle('hidden',me?.role!=='owner'));
  $('members').innerHTML=state.participants.map(p=>`<div class="member"><span class="avatar ${avatar(p.id)}">${e(p.name.slice(0,1))}</span><div class="member-info"><strong>${e(p.name)}${p.id===me?.id?'<span class="me-badge">나</span>':''}</strong><small>${e(p.runner?.error?'연결 오류':p.runner?.account||'Codex 연결 대기')}</small></div><span class="member-status ${p.runner?.online?'online':''}">${p.runner?.online?'연결됨':'대기'}</span>${me?.role==='owner'&&p.id!==me.id?`<button class="icon-button revoke" data-id="${e(p.id)}" title="참여 권한 회수">×</button>`:''}</div>`).join('');
  document.querySelectorAll('.revoke').forEach(b=>b.onclick=()=>{modal(`<h2>참여 권한 회수</h2><p>이 참여자의 후속 세션 접근과 대기 중인 작업을 차단합니다. 이미 전달된 기록은 회수할 수 없습니다.</p><div class="modal-actions"><button class="button primary" id="confirm-revoke">권한 회수</button></div>`);$('confirm-revoke').onclick=async()=>{try{await api(`/api/members/${b.dataset.id}/revoke`,{});$('modal').close();}catch(err){toast(err.message);}};});
  const myRunner=state.participants.find(p=>p.id===me?.id)?.runner;
  $('connect-label').textContent=myRunner?.online?'Codex 연결됨':'내 Codex 연결';
  const catalog=myRunner?.catalog;
  $('tool-catalog').textContent=catalog?.native?`기본 도구 활성화 · MCP ${catalog.mcpTools??'확인 중'}개 · 스킬 ${catalog.skills??'확인 중'}개 · 하위 세션 ${state.nativeThreadCount||0}개 보관`:'첫 실행에서 내 MCP·스킬을 확인합니다. 기본 셸·파일·웹 검색을 사용할 수 있습니다.';
  $('billing-label').textContent=myRunner?.accountType==='chatgpt'?'내 구독 계정':myRunner?.accountType?'API 계정':'내 계정';
  const warnings=[];
  if(state.blocked)warnings.push(state.blocked);
  if(state.sameAccount)warnings.push('두 실행기가 같은 Codex 계정으로 연결되어 있습니다. 세션 교대는 확인할 수 있지만 계정별 할당량 분리 검증은 아닙니다.');
  if(myRunner?.error)warnings.push(myRunner.error);
  $('notice').textContent=warnings.join('\n');$('notice').classList.toggle('hidden',!warnings.length);
  const active=state.turns.find(t=>['running','syncing'].includes(t.status)),queued=state.turns.filter(t=>t.status==='queued');
  $('queue-status').textContent=active?`${active.authorName}의 AI가 ${active.compacting?'이전 원문을 보관하며 컨텍스트를 압축하고 있어요':active.status==='syncing'?'같은 세션을 적용하고 있어요':'작업하고 있어요'}.${queued.length?` 다음 지시 ${queued.length}개 대기 중`:''}`:queued.length?`${queued[0].authorName}의 실행기 연결을 기다리고 있어요.`:'공유 기록을 유지하며 한 차례씩 실행합니다.';
  $('send').disabled=!!state.blocked||me?.role==='observer';
  $('revision').textContent=state.revision;$('accounts').textContent=state.distinctAccounts;
  $('native-id').textContent=state.nativeId||'첫 실행 후 생성됩니다';$('checkpoint-hash').textContent=state.revision?state.checkpointHash:'아직 기록이 없습니다';
  $('new-session').classList.toggle('hidden',me?.role!=='owner');
  $('network-label').textContent=state.remoteAccess?.mode==='tailscale'?(state.remoteAccess.connected?'Tailscale 연결됨':'Tailscale 설정'):state.remoteAccess?.connected?(new URL(state.remoteAccess.url).protocol==='https:'?'중계 연결됨':'중계 테스트 연결'):state.remoteAccess?.enabled?'중계 재연결 중':'이 PC에서 연결';
  renderTurns();
  const stamp=state.id+':'+state.revision+':'+state.turns.flatMap(t=>t.tools||[]).filter(t=>t.native&&t.status==='completed').map(t=>t.at).join(',')+':'+state.turns.flatMap(t=>t.tools||[]).filter(t=>t.name==='host_write_file'&&t.result?.success).map(t=>t.result.output.hash).join(',');
  if(stamp!==fileStamp||Date.now()-lastFilesRefresh>10_000){fileStamp=stamp;lastFilesRefresh=Date.now();refreshFiles();refreshPreview();}
  features.render(state,me);
}
function renderTurns(){
  const nextStamp=JSON.stringify([state.turns,[...partial.values()],me.id,state.blocked]);if(nextStamp===turnsStamp)return;turnsStamp=nextStamp;
  const timeline=$('timeline'),atBottom=timeline.scrollHeight-timeline.scrollTop-timeline.clientHeight<100;
  $('empty-state').classList.toggle('hidden',state.turns.length>0);
  $('turns').innerHTML=state.turns.map((turn,index)=>{
    const finished=new Set(turn.items.map(i=>i.id));
    const flowing=[...partial.values()].filter(i=>i.turnId===turn.id&&!finished.has(i.id));
    return `<article class="turn" id="turn-${e(turn.id)}"><div class="turn-top"><span class="avatar ${avatar(turn.authorId)}">${e(turn.authorName.slice(0,1))}</span><strong>${e(turn.authorName)}</strong><span class="turn-status ${e(turn.status)}">${e(turn.retriedAs?'다시 요청됨':turn.compacting&&turn.status==='running'?'컨텍스트 압축 중':statusLabels[turn.status]||turn.status)}</span><time>${e(new Date(turn.createdAt).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'}))}</time>${['queued','running','syncing'].includes(turn.status)&&(turn.authorId===me.id||me.role==='owner')?`<button class="cancel-button" data-cancel="${e(turn.id)}">중단</button>`:''}</div><div class="turn-prompt">${e(turn.prompt)}</div>${turn.items.length||flowing.length?`<div class="response-label"><span>⌘</span> CODEX <span>·</span> ${e(turn.authorName)}의 계정</div>`:''}${turn.items.map(item=>`<div class="response ${item.phase==='commentary'?'commentary':''}">${e(item.text)}</div>`).join('')}${flowing.map(item=>`<div class="response">${e(item.text)}</div>`).join('')}${renderInteractions(turn)}${turn.tools.length?`<div class="tool-list">${turn.tools.map(tool=>`<details class="tool-detail"><summary><span>${tool.result?.success?'✓':tool.status==='pending'?'◌':'!'}</span> ${e(tool.name.replace('host_',''))} ${e(tool.args?.path||tool.args?.command||'')} <span class="muted">${tool.location==='account'?'내 연결 도구':'호스트'}</span></summary><pre>${e(JSON.stringify(tool.result?.output||tool.args,null,2))}</pre></details>`).join('')}</div>`:''}${['syncing','running'].includes(turn.status)&&!flowing.length?`<div class="pending-dots">${turn.compacting?'이전 원문을 보관하며 Codex 컨텍스트 압축 중':turn.status==='syncing'?'이전 지시·응답·도구 결과를 그대로 적용 중':'같은 세션에서 작업 중'} ···</div>`:''}${turn.error?`<div class="turn-error">${turn.failurePhase==='resume_rejected'?(turn.retriedAs?'작업 시작 전 연결 충돌이 있었습니다. 아래에서 다시 요청한 결과를 확인하세요.':'다른 Codex 실행기가 세션을 사용 중이어서 작업을 시작하지 못했습니다. 저장된 기록은 유지됩니다.'):turn.failurePhase==='compaction_interrupted'?(turn.retriedAs?'압축 중단 기록을 복구했습니다. 아래에서 다시 요청한 결과를 확인하세요.':'중단된 원본 기록을 복구했습니다. 다시 실행하면 같은 세션에서 이어갑니다.'):e(turn.error)}</div>`:''}${turn.retryable&&turn.authorId===me.id&&!state.blocked?`<button class="button" data-retry="${e(turn.id)}">다시 실행</button>`:''}${turn.appliedRevision!==undefined?`<div class="turn-proof">SESSION ${e((turn.nativeId||'').slice(-12))} · v${turn.appliedRevision} ${turn.committedRevision?`→ v${turn.committedRevision} · 이전 기록 보존 확인`:'· 원본 적용 확인'}${turn.account?`<br>${e(turn.account)}`:''}</div>`:''}</article>`;
  }).join('');
  document.querySelectorAll('[data-interaction]').forEach(b=>b.onclick=()=>openInteraction(b.dataset.interaction));
  document.querySelectorAll('[data-cancel]').forEach(b=>b.onclick=async()=>{try{await api(`/api/turns/${b.dataset.cancel}/cancel`,{});toast('중단 요청을 보냈습니다. 저장된 기록은 유지됩니다.');}catch(err){toast(err.message);}});
  document.querySelectorAll("[data-retry]").forEach(b=>b.onclick=async()=>{b.disabled=true;try{await api(`/api/turns/${b.dataset.retry}/retry`,{});toast("같은 세션으로 다시 실행을 요청했습니다.");}catch(err){b.disabled=false;toast(err.message);}});
  if(atBottom)timeline.scrollTop=timeline.scrollHeight;
}
async function refreshFiles(){try{const result=await api('/api/files');$('file-list').innerHTML=result.files.length?result.files.map(f=>`<button class="file-row" data-file="${e(f.path)}"><span>▤ &nbsp;${e(f.path)}</span><small>${Math.max(1,Math.round(f.bytes/1024))} KB</small></button>`).join(''):'<p class="empty-list">아직 파일이 없습니다.</p>';document.querySelectorAll('[data-file]').forEach(b=>b.onclick=()=>showFile(b.dataset.file));if(selectedFile)showFile(selectedFile);}catch(err){toast(err.message);}}
async function showFile(name){
  selectedFile=name;$('file-view').innerHTML=`<strong>${e(name)}</strong><button class="button small" id="download-file">다운로드</button><div id="file-content">불러오는 중…</div>`;
  $('download-file').onclick=async()=>{try{const res=await fetch('/api/download?path='+encodeURIComponent(name),{headers:{Authorization:`Bearer ${credential}`}});if(!res.ok)throw new Error((await res.json()).error);download(await res.blob(),name.split('/').at(-1));}catch(error){toast(error.message);}};
  try{const file=await api('/api/file?path='+encodeURIComponent(name));if(selectedFile===name)$('file-content').innerHTML=`<pre>${e(file.content)}</pre><small>SHA-256 ${e(file.hash.slice(0,16))}</small>`;}
  catch(error){if(selectedFile!==name)return;$('file-content').textContent=error.message;
    if(/\.(png|jpe?g|gif|webp)$/i.test(name)){try{const res=await fetch('/api/download?path='+encodeURIComponent(name),{headers:{Authorization:`Bearer ${credential}`}});if(!res.ok)return;const blob=await res.blob(),url=URL.createObjectURL(blob);if(selectedFile===name){$('file-content').innerHTML=`<img class="artifact-image" src="${url}" alt="${e(name)}">`;$('file-content').querySelector('img').onload=()=>URL.revokeObjectURL(url);}else URL.revokeObjectURL(url);}catch{}}
  }
}
async function refreshPreview(){if(features.devPreview())return;try{const file=await api('/api/file?path=index.html');if(file.hash!==previewHash||!$('preview').hasAttribute('srcdoc')){previewHash=file.hash;const policy="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'";$('preview').srcdoc=`<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">`+file.content;}document.querySelector('.preview-caption span').textContent='index.html';$('preview-version').textContent=`${file.hash.slice(0,8)} · 최신 파일`;}catch{$('preview').srcdoc='<p style="font:12px sans-serif;color:#8c9a80;padding:25px">호스트에 index.html을 만들면 여기에 표시됩니다.</p>';$('preview-version').textContent='index.html 대기';}}
$('refresh-preview').onclick=()=>{if(features.devPreview())return $('preview-live').onclick();previewHash='';refreshPreview();};
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-tab]').forEach(t=>t.classList.toggle('active',t===b));for(const tab of ['preview','files','session'])$('panel-'+tab).classList.toggle('hidden',tab!==b.dataset.tab);});
document.querySelectorAll('[data-prompt]').forEach(b=>b.onclick=()=>{$('prompt').value=b.dataset.prompt;$('prompt').focus();});
let submitting=false,pendingSubmission=null;
$('composer').onsubmit=async event=>{event.preventDefault();const prompt=$('prompt').value.trim();if(!prompt||submitting||me?.role==='observer')return;submitting=true;$('send').disabled=true;if(pendingSubmission?.prompt!==prompt)pendingSubmission={prompt,requestId:crypto.randomUUID()};try{await api('/api/turns',pendingSubmission);pendingSubmission=null;$('prompt').value='';$('timeline').scrollTop=$('timeline').scrollHeight;}catch(err){toast(err.message);}finally{submitting=false;$('send').disabled=!!state?.blocked||me?.role==='observer';}};
$('prompt').onkeydown=event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){$('composer').requestSubmit();event.preventDefault();}};
async function copy(text){try{await navigator.clipboard.writeText(text);toast('복사했습니다.');}catch{toast('자동 복사가 차단되었습니다. 표시된 내용을 직접 복사하세요.');}}
document.querySelectorAll('.invite-trigger').forEach(b=>b.onclick=async()=>{try{
  if(me.role!=='owner'){toast('초대 링크는 호스트가 만들 수 있습니다.');return;}
  const invitation=await api('/api/invites',{});let link=(invitation.url||location.origin)+'/#invite='+encodeURIComponent(invitation.code);
  const remote=invitation.url?.startsWith('https:'),isTailscale=invitation.mode==='tailscale';
  modal(`<div class="eyebrow">BETTER TOGETHER</div><h2>같은 세션으로 초대하기</h2><p>이전 지시와 작업 결과까지 공유합니다.<br>링크는 24시간 동안 한 번 사용할 수 있어요.</p>${isTailscale?'<div class="network-steps"><strong>먼저 Tailscale에서 연결해 주세요</strong><p>참여자도 Tailscale에 로그인해야 합니다. 서로 다른 네트워크 계정이라면 호스트 기기의 공유 초대를 먼저 수락한 뒤 아래 링크를 여세요.</p><a class="text-button" href="https://login.tailscale.com/admin/machines" target="_blank" rel="noopener noreferrer">Tailscale 기기 공유 관리 ↗</a></div>':''}<label for="invite-link">${isTailscale?'Tailscale 사설 초대 링크':'초대 링크'}</label><input id="invite-link" value="${e(link)}" readonly><div class="modal-actions"><button class="button primary" id="copy-invite">초대 링크 복사</button></div><p class="small-note">${isTailscale?'이 링크만으로 Tailscale 기기 접근 권한까지 발급되지는 않습니다. 링크를 받은 사람에게 세션 참여 권한을 주므로 초대할 사람에게만 전달하세요.':remote?'링크를 받은 사람이 참여 권한을 얻으므로 초대할 사람에게만 전달하세요.':'이 주소는 로컬 연결 주소입니다. 127.0.0.1 링크는 이 PC에서만 열립니다.'} 내 Codex 사용에는 hand-in-hand 연결 프로그램이 필요합니다.</p>`);
  $('copy-invite').onclick=()=>copy(link);
  $('invite-link').insertAdjacentHTML('beforebegin','<label for="invite-role">초대 권한</label><select id="invite-role"><option value="member">작업 참여자 · 내 AI로 지시</option><option value="observer">관찰자 · 기록과 결과만 보기</option></select>');
  $('invite-role').onchange=async()=>{try{$('copy-invite').disabled=true;const next=await api('/api/invites',{role:$('invite-role').value});link=(next.url||location.origin)+'/#invite='+encodeURIComponent(next.code);$('invite-link').value=link;$('copy-invite').disabled=false;}catch(error){toast(error.message);}};
}catch(err){toast(err.message);}});
async function pairingDialog(){const result=await api('/api/pairing',{}),agentHost=state.remoteAccess?.connected?state.remoteAccess.url:location.origin;modal(`<div class="eyebrow">YOUR ACCOUNT, OUR SESSION</div><h2>내 기기의 Codex 연결</h2><p>내 컴퓨터에서 공식 Codex에 로그인한 뒤 연결 프로그램을 실행하세요. 인증 정보는 내 기기에 남습니다.</p><div class="connection-code">${e(result.code.slice(0,6))} ${e(result.code.slice(6))}</div><div class="command">npm run agent -- --host ${e(agentHost)}</div><p>프로그램이 연결 코드를 물으면 위 코드를 입력하세요.</p><div class="modal-actions"><button class="button" id="copy-code">코드 복사</button><button class="button primary" id="pair-done">확인</button></div><p class="small-note">${state.remoteAccess?.mode==='tailscale'?'이 기기도 Tailscale로 호스트에 연결되어 있어야 합니다. ':''}코드는 10분 동안 한 번만 사용합니다. 이 프로토타입은 Node.js 22 이상과 Codex CLI가 필요합니다. 처음 설치하거나 업데이트했다면 npm ci를 먼저 실행하세요.</p>`);$('copy-code').onclick=()=>copy(result.code);$('pair-done').onclick=()=>$('modal').close();}
function networkDialog(){
  const access=state?.remoteAccess;
  if(access?.mode==='tailscale'){
    modal(`<div class="eyebrow">PRIVATE CONNECTION, SHARED SESSION</div><h2>Tailscale로 함께 연결하기</h2><p>호스트와 참여자가 Tailscale로 연결되면 다른 장소에서도 같은 세션을 이어갑니다.</p><div class="network-steps"><strong>${access.connected?'사설 HTTPS 연결이 준비됐어요':access.running?'Tailscale 로그인 확인됨':access.installed===false?'Tailscale 설치가 필요해요':'Tailscale 연결을 확인해 주세요'}</strong>${access.url?`<p class="network-address">${e(access.url)}</p>`:''}${access.error?`<p class="error-text">${e(access.error)}</p>`:''}</div>${canManageNetwork?`<div class="modal-actions"><button class="button" data-network-action="refresh">상태 다시 확인</button><button class="button primary" data-network-action="${access.connected?'disable':'enable'}">${access.connected?'사설 연결 끄기':'Tailscale 연결 켜기'}</button></div>`:''}${access.setupUrl?`<p><a class="text-button" href="${e(access.setupUrl)}" target="_blank" rel="noopener noreferrer">Tailscale HTTPS 설정 열기 ↗</a></p>`:''}<ol><li>두 기기에 Tailscale을 설치하고 각자 로그인합니다.</li><li>다른 계정의 동료라면 호스트 기기를 공유하고, 동료가 공유 초대를 수락합니다.</li><li>hand-in-hand 초대 링크를 보내 같은 세션에 참여합니다.</li><li>참여자가 자신의 Codex를 연결합니다.</li></ol><div class="modal-actions"><a class="button" href="https://tailscale.com/download" target="_blank" rel="noopener noreferrer">Tailscale 다운로드 ↗</a><a class="button" href="https://login.tailscale.com/admin/machines" target="_blank" rel="noopener noreferrer">기기 공유 관리 ↗</a></div><p class="small-note">Tailscale 기기 접근과 세션 초대는 각각 필요합니다. 이 버전은 개인 계정으로 연결한 기기를 지원합니다. 기기 공유 시 다른 서비스의 접근 범위는 Tailscale 정책에서 정합니다.</p>`);
    document.querySelectorAll('[data-network-action]').forEach(button=>button.onclick=async()=>{document.querySelectorAll('[data-network-action]').forEach(b=>b.disabled=true);try{await api('/api/network/tailscale/'+button.dataset.networkAction,{});}catch(err){toast(err.message);}finally{try{const next=await api('/api/state');render(next);networkDialog();}catch(err){toast(err.message);}}});
    return;
  }
  modal(`<div class="eyebrow">INVITE. CONNECT. CONTINUE.</div><h2>어디서든 같은 세션으로</h2><p>호스트 앱이 중계 서버에 연결하면 동료는 초대 링크로 참여합니다. Tailscale이나 별도 VPN을 설치할 필요가 없습니다.</p><div class="shared-card"><strong>${access?.connected?(access.url.startsWith('https:')?'인터넷 중계에 연결되어 있어요':'이 PC에서 중계를 시험하고 있어요'):access?.enabled?'중계에 다시 연결하고 있어요':'인터넷 중계가 아직 연결되지 않았어요'}</strong><p>${access?.url?e(access.url):'실제 인터넷 주소를 제공할 중계 서버를 먼저 준비해야 합니다.'}</p></div>${access?.error?`<p class="error-text">${e(access.error)}</p>`:''}<ol><li>호스트가 hand-in-hand를 켜 둡니다.</li><li>초대받은 사람이 링크로 세션에 참여합니다.</li><li>자신의 Codex를 연결하고 이전 작업을 이어갑니다.</li></ol><p class="small-note">초대 링크 없이 대화·파일을 볼 수 없습니다. 내 AI 계정 사용에는 hand-in-hand 연결 프로그램이 필요합니다. 현재 중계는 신뢰하는 서버에서 운영하며, 전송 중인 공유 데이터가 서버를 통과합니다.</p>`);
}
$('network').onclick=networkDialog;
$('connect').onclick=async()=>{try{if(canLocalConnect){modal(`<div class="eyebrow">YOUR ACCOUNT, OUR SESSION</div><h2>내 Codex로 연결하기</h2><p>이 PC의 공식 Codex 로그인으로 실행합니다. 여기서 보낸 지시는 해당 계정의 사용량을 사용해요.</p><div class="modal-actions"><button class="button primary" id="local-connect">이 PC의 Codex 연결</button><button class="button" id="remote-connect">다른 기기 연결</button></div>`);$('local-connect').onclick=async()=>{try{await api('/api/local-agent',{});$('modal').close();toast('Codex 로그인 상태를 확인하고 있습니다.');}catch(err){toast(err.message);}};$('remote-connect').onclick=()=>pairingDialog().catch(err=>toast(err.message));}else await pairingDialog();}catch(err){toast(err.message);}};
$('guide').onclick=()=>modal(`<div class="eyebrow">A → B → A</div><h2>대화를 이어가 보세요</h2><ol><li>내 Codex를 연결하고 첫 지시를 입력합니다.</li><li>초대 링크로 동료가 같은 세션에 참여합니다.</li><li>동료가 자신의 기기에서 Codex를 연결합니다.</li><li>동료가 “방금 정한 조건대로 수정해줘”라고 지시합니다.</li><li>내가 다시 이어서 요청하면 동료의 작업까지 적용됩니다.</li></ol><p>오른쪽 ‘세션 기록’에서 동일 Codex 세션 ID와 원본 버전을 확인하세요.</p><p class="small-note">새 세션은 원본 기록을 보관한 뒤 별도로 시작합니다. 기본 공유 폴더는 workspace입니다. 셸·파일 작업은 호스트에서 실행하고 승인과 질문은 대화에서 응답합니다. 오른쪽에서는 텍스트 파일과 단일 HTML 미리보기를 확인할 수 있습니다.</p>`);
$('new-session').onclick=()=>{modal(`<h2>새 세션 시작하기</h2><p>현재 세션은 호스트의 archives 폴더에 보관합니다. 프로젝트 파일은 유지됩니다.</p><label for="new-title">세션 이름</label><input id="new-title" value="새로운 프로젝트" maxlength="80"><div class="modal-actions"><button class="button primary" id="create-session">새 세션 만들기</button></div>`);$('create-session').onclick=async()=>{try{await api('/api/session/new',{title:$('new-title').value});partial.clear();$('modal').close();toast('새 세션을 시작했습니다.');}catch(err){toast(err.message);}};};
async function watch(){
  streamController?.abort();streamController=new AbortController();
  while(!streamController.signal.aborted){
    try{const response=await fetch('/api/events',{headers:{Authorization:`Bearer ${credential}`},signal:streamController.signal});if(!response.ok)throw new Error('세션 연결 권한을 확인하세요.');$('connection-status').textContent='연결됨';const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
      for(;;){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let index;while((index=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,index);buffer=buffer.slice(index+2);const kind=block.match(/^event: (.+)$/m)?.[1],raw=block.match(/^data: (.+)$/m)?.[1];if(!raw)continue;const data=JSON.parse(raw);if(kind==='state')render(data);if(kind==='delta'){const key=data.turnId+':'+data.itemId;const item=partial.get(key)||{turnId:data.turnId,id:data.itemId,text:''};item.text+=data.delta;partial.set(key,item);if(state)renderTurns();}}}
    }catch(error){if(streamController.signal.aborted)return;$('connection-status').textContent='재연결 중';}
    await new Promise(r=>setTimeout(r,2000));
  }
}
async function start(){const initial=await api('/api/state');me=initial.me;canLocalConnect=initial.canLocalConnect;canManageNetwork=initial.canManageNetwork;render(initial);watch();}
const invite=new URLSearchParams(location.hash.slice(1)).get('invite');
if(invite){modal(`<div class="join-brand">↔ hand-in-hand.</div><h2>같은 세션에 참여하기</h2><p>동료의 이전 지시와 AI 작업 결과를 그대로 이어갑니다.</p><form id="join-form"><label for="join-name">함께 작업할 이름</label><input id="join-name" placeholder="이름" required maxlength="30" autocomplete="nickname"><div class="modal-actions"><button class="button primary" type="submit">세션 참여하기</button></div><p class="error-text" id="join-error"></p></form>`);$('join-form').onsubmit=async event=>{event.preventDefault();try{const joined=await api('/api/join',{code:invite,name:$('join-name').value});credential=joined.token;sessionStorage.setItem('hih-token',credential);history.replaceState(null,'',location.pathname);$('modal').close();await start();}catch(err){$('join-error').textContent=err.message;}};
}else{
  (async()=>{if(!credential){const result=await api('/api/bootstrap',{});credential=result.token;sessionStorage.setItem('hih-token',credential);}await start();})().catch(err=>modal(`<h2>세션 연결이 필요해요</h2><p>${e(err.message)}</p><p>호스트 PC에서 먼저 앱을 열거나 초대 링크로 참여하세요.</p><div class="modal-actions"><button class="button" id="retry">연결 다시 확인</button></div>`)).then(()=>{if($('retry'))$('retry').onclick=()=>{sessionStorage.removeItem('hih-token');location.reload();};});
}
