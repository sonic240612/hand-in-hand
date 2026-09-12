export function managementFeatures({api,modal,toast,escape:e,getState,getMe,canManageWorkspace}){
  const $=id=>document.getElementById(id);
  document.querySelector('.panel-tabs').insertAdjacentHTML('beforeend','<button data-tab="runtime">실행</button>');
  document.querySelector('.result-panel').insertAdjacentHTML('beforeend','<section class="panel-content hidden" id="panel-runtime"><div class="integrity-heading"><div><strong>프로젝트 개발 서버</strong><small>호스트에서 실행하고 함께 확인합니다</small></div></div><p id="runtime-status" role="status"></p><div class="project-actions"><button class="button primary small" id="runtime-start">스크립트 실행</button><button class="button small" id="runtime-stop">중지</button><button class="button small" id="runtime-preview">화면 공유</button></div><p class="small-note" id="runtime-error"></p><pre class="runtime-log" id="runtime-log" tabindex="0" aria-label="개발 서버 로그"></pre><p class="small-note">실행할 npm 스크립트를 확인한 뒤 시작합니다. 포트는 스크립트의 실제 설정과 같아야 합니다. 마지막 64,000자의 로그를 공유하며 호스트 종료 시 서버도 중지합니다.</p></section>');
  $('export-session').insertAdjacentHTML('afterend','<button class="button small" id="rename-session">이름 변경</button>');
  $('rename-session').insertAdjacentHTML('afterend','<button class="button small" id="workspace-settings">작업공간 설정</button><button class="button small" id="new-session-panel">새 세션</button>');
  $('new-session-panel').onclick=()=>$('new-session').click();
  $('rename-session').onclick=()=>{modal(`<h2>세션 이름 변경</h2><label for="new-title">세션 이름</label><input id="new-title" maxlength="80" value="${e(getState().title)}"><div class="modal-actions"><button class="button primary" id="save-title">저장</button></div>`);$('save-title').onclick=async()=>{try{await api('/api/session/title',{title:$('new-title').value});$('modal').close();}catch(error){toast(error.message);}};};
  $('runtime-start').onclick=async()=>{
    try{
      const catalog=await api('/api/dev-server/scripts');
      modal(`<h2>개발 서버 실행</h2><p>현재 프로젝트의 package.json에서 실행할 스크립트를 선택하세요. 호스트 계정으로 실행하며 출력은 참여자에게 공유됩니다.</p>${catalog.scripts.length?`<label for="runtime-script">npm 스크립트</label><select id="runtime-script">${catalog.scripts.map(s=>`<option value="${e(s.name)}" ${s.name==='dev'?'selected':''}>${e(s.name)}</option>`).join('')}</select><pre class="approval-preview" id="runtime-command"></pre><label for="runtime-port">스크립트가 사용하는 포트</label><input id="runtime-port" type="number" min="1024" max="65535" value="${e(getState().devServer?.port||5173)}"><p class="small-note">이 값은 스크립트의 포트를 바꾸지 않습니다. 필요한 패키지가 없다면 호스트에서 npm ci를 먼저 실행하세요.</p><div class="modal-actions"><button class="button primary" id="run-reviewed-script">이 스크립트 실행</button></div>`:'<p>실행할 npm 스크립트가 없습니다. 프로젝트에 package.json과 dev 스크립트를 준비하세요.</p>'}`);
      if(!catalog.scripts.length)return;
      const command=()=>{$('runtime-command').textContent=catalog.scripts.find(s=>s.name===$('runtime-script').value).command;};command();$('runtime-script').onchange=command;
      $('run-reviewed-script').onclick=async()=>{try{$('run-reviewed-script').disabled=true;await api('/api/dev-server/start',{script:$('runtime-script').value,expectedHash:catalog.hash,port:Number($('runtime-port').value)});$('modal').close();toast('개발 서버를 시작했습니다. 로그에서 준비 상태를 확인하세요.');}catch(error){$('run-reviewed-script').disabled=false;toast(error.message);}};
    }catch(error){toast(error.message);}
  };
  $('runtime-stop').onclick=async()=>{try{$('runtime-stop').disabled=true;await api('/api/dev-server/stop',{});toast('개발 서버를 중지했습니다.');}catch(error){toast(error.message);$('runtime-stop').disabled=false;}};
  $('runtime-preview').onclick=async()=>{try{await api('/api/preview/config',{port:getState().devServer.port});document.querySelector('[data-tab="preview"]').click();await $('preview-live').onclick();}catch(error){toast(error.message);}};
  $('workspace-settings').onclick=async()=>{
    try{const current=await api('/api/workspace');modal(`<h2>공유할 프로젝트 폴더</h2><p>현재 폴더</p><code class="identifier">${e(current.root)}</code><label for="workspace-path">호스트에 있는 새 프로젝트 폴더의 절대 경로</label><input id="workspace-path" placeholder="${e(current.root)}"><div class="modal-actions"><button class="button primary" id="inspect-workspace">폴더 확인</button></div><div id="workspace-review"></div>`);
      $('inspect-workspace').onclick=async()=>{try{const selected=await api('/api/workspace/inspect',{path:$('workspace-path').value.trim()});$('workspace-review').innerHTML=`<h3>${e(selected.name)}</h3><code class="identifier">${e(selected.root)}</code><pre class="approval-preview">${e(selected.files.map(f=>f.path).join('\n')||'(빈 프로젝트)')}</pre><p>현재 세션은 보관하고 새 세션을 시작합니다. 다른 참여자의 접근 권한은 회수되므로 새 폴더를 함께 사용할 사람을 다시 초대하세요. 파일은 옮기거나 삭제하지 않습니다.</p><button class="button primary" id="open-workspace">이 폴더로 새 세션 열기</button>`;$('open-workspace').onclick=async()=>{try{$('open-workspace').disabled=true;await api('/api/workspace/open',{path:selected.root,hash:selected.hash});$('modal').close();toast('새 작업공간을 열었습니다. 참여자를 다시 초대하세요.');}catch(error){$('open-workspace').disabled=false;toast(error.message);}};}catch(error){toast(error.message);}};
    }catch(error){toast(error.message);}
  };
  return {render(state,me){
    $('workspace-settings').classList.toggle('hidden',!canManageWorkspace());$('rename-session').classList.toggle('hidden',me.role!=='owner');$('new-session-panel').classList.toggle('hidden',me.role!=='owner');
    const server=state.devServer||{},active=['starting','running','stopping'].includes(server.status),labels={starting:'시작 중',running:'프로세스 실행 중',stopping:'중지 중',stopped:'중지됨',failed:'실행 실패',interrupted:'호스트 종료로 상태 확인 필요'};
    $('runtime-status').textContent=`${labels[server.status]||'중지됨'}${server.script?' · npm run '+server.script:''}${server.port?' · :'+server.port:''}`;
    $('runtime-error').textContent=server.error||'';
    const log=$('runtime-log'),bottom=log.scrollHeight-log.scrollTop-log.clientHeight<60;if(log.textContent!==(server.log||'')){log.textContent=server.log||'서버를 실행하면 로그가 여기에 표시됩니다.';if(bottom)log.scrollTop=log.scrollHeight;}
    for(const id of ['runtime-start','runtime-stop','runtime-preview'])$(id).classList.toggle('hidden',me.role!=='owner');
    $('runtime-start').disabled=active||state.workspaceBusy||state.closing||state.turns.some(t=>['running','syncing'].includes(t.status));$('runtime-stop').disabled=!active||server.status==='stopping';$('runtime-preview').disabled=server.status!=='running';
    for(const turn of state.turns){
      const element=$('turn-'+turn.id);if(!element||element.dataset.managementDecorated)continue;element.dataset.managementDecorated='true';
      if(turn.edits?.length)element.insertAdjacentHTML('beforeend',`<details class="change-detail"><summary>지시 수정 기록 ${turn.edits.length}개</summary>${turn.edits.map(edit=>`<pre>${e(edit.prompt)}</pre>`).join('')}</details>`);
      if(turn.status==='queued'&&turn.authorId===me.id)element.insertAdjacentHTML('beforeend',`<button class="button small" data-edit-turn="${e(turn.id)}">대기 지시 수정</button>`);
      if(turn.recoveredAt)element.insertAdjacentHTML('beforeend','<p class="small-note">세션 원본을 검사해 복구했습니다.</p>');
    }
    document.querySelectorAll('[data-edit-turn]').forEach(button=>button.onclick=()=>{const turn=getState().turns.find(t=>t.id===button.dataset.editTurn);modal(`<h2>대기 중인 지시 수정</h2><p>이전 지시는 수정 기록에 남고 새 지시로 실행됩니다.</p><textarea id="edit-prompt" maxlength="20000">${e(turn.prompt)}</textarea><div class="modal-actions"><button class="button primary" id="save-edit">수정 저장</button></div>`);$('save-edit').onclick=async()=>{try{await api('/api/turns/'+turn.id+'/edit',{expectedPrompt:turn.prompt,prompt:$('edit-prompt').value});$('modal').close();}catch(error){toast(error.message);}};});
  }};
}
