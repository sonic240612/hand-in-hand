export function projectFeatures({api,modal,toast,escape:e,getState,getMe,refreshFiles,refreshPreview,download}){
  const $=id=>document.getElementById(id);
  let devPreview=false,currentPort=null,uploading=false;
  document.querySelector('.preview-toolbar').insertAdjacentHTML('afterend','<div class="project-actions"><button class="button small" id="preview-settings">개발 서버 연결</button><button class="button small" id="preview-static">HTML 보기</button><button class="button small" id="preview-live">개발 서버 보기</button></div>');
  $('panel-files').insertAdjacentHTML('afterbegin','<div class="project-actions"><button class="button small" id="upload-file">파일 올리기</button><button class="button small" id="reload-files">새로고침</button></div><p class="small-note" id="upload-progress" role="status"></p>');
  $('panel-session').insertAdjacentHTML('beforeend','<div class="project-actions"><button class="button small" id="export-session">세션 원본 내보내기</button></div><div class="detail-label">파일 작업 기록</div><div id="file-events" class="scope-note"></div>');
  $('export-session').insertAdjacentHTML('afterend','<button class="button small" id="archived-sessions">보관된 세션</button>');
  $('archived-sessions').onclick=async()=>{try{const result=await api('/api/session/archives');modal(`<h2>보관된 세션</h2><p>읽기 전용 기록입니다. 현재 세션과 프로젝트 파일은 유지됩니다.</p>${result.archives.map(a=>`<button class="file-row" data-archive="${e(a.id)}"><span>${e(a.title)}</span><small>v${a.revision} · ${a.turns}턴</small></button>`).join('')||'<p>아직 보관된 세션이 없습니다.</p>'}`);document.querySelectorAll('[data-archive]').forEach(b=>b.onclick=async()=>{try{const saved=await api('/api/session/archives/'+b.dataset.archive);modal(`<h2>${e(saved.title)}</h2><p>${e(saved.nativeId||'실행 전')} · v${saved.revision}</p>${saved.turns.map(t=>`<details class="change-detail"><summary>${e(t.authorName)} · ${e(t.prompt)}</summary>${t.items.map(i=>`<pre class="approval-preview">${e(i.text)}</pre>`).join('')}</details>`).join('')}`);}catch(error){toast(error.message);}});}catch(error){toast(error.message);}};
  const staticPreview=()=>{devPreview=false;currentPort=null;$('preview').setAttribute('sandbox','allow-scripts');$('preview').removeAttribute('src');refreshPreview();};
  $('preview-static').onclick=staticPreview;
  $('preview-live').onclick=async()=>{try{const result=await api('/api/preview/open',{});devPreview=true;currentPort=getState().preview.targetPort;$('preview').setAttribute('sandbox','allow-scripts allow-same-origin');$('preview').removeAttribute('srcdoc');$('preview').src=result.url;$('preview-version').textContent=`개발 서버 :${currentPort} · 연결 1시간`;document.querySelector('.preview-caption span').textContent='개발 서버';}catch(error){toast(error.message);}};
  $('preview-settings').onclick=()=>{
    const config=getState().preview;
    modal(`<h2>개발 서버 미리보기</h2><p>호스트에서 실행 중인 개발 서버의 포트를 입력하세요. 연결한 포트의 화면과 실시간 갱신을 초대한 사람에게 공유합니다.</p><label for="dev-port">호스트 개발 서버 포트</label><input id="dev-port" type="number" min="1024" max="65535" value="${e(config.targetPort||5173)}"><p class="small-note">예: Vite 5173, Next.js 3000. Tailscale 미리보기는 별도 사설 HTTPS 포트 8444를 사용합니다. 서버는 Codex 지시 또는 호스트 터미널에서 실행해 주세요.</p>${config.error?`<p class="error-text">${e(config.error)}</p>`:''}<div class="modal-actions"><button class="button" id="disable-dev">공유 끄기</button><button class="button primary" id="enable-dev">이 포트 공유</button></div>`);
    const configure=async value=>{try{document.querySelectorAll('#enable-dev,#disable-dev').forEach(b=>b.disabled=true);const result=await api('/api/preview/config',{port:value});$('modal').close();if(value)await $('preview-live').onclick();else staticPreview();toast(result.error||'미리보기 설정을 반영했습니다.');}catch(error){toast(error.message);document.querySelectorAll('#enable-dev,#disable-dev').forEach(b=>b.disabled=false);}};
    $('enable-dev').onclick=()=>configure(Number($('dev-port').value));$('disable-dev').onclick=()=>configure(null);
  };
  $('reload-files').onclick=refreshFiles;
  $('export-session').onclick=async()=>{try{const data=await api('/api/session/export');download(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),`hand-in-hand-session-${getState().revision}.json`);}catch(error){toast(error.message);}};
  $('upload-file').onclick=()=>{
    modal('<h2>호스트에 파일 올리기</h2><p>파일은 호스트 프로젝트에 저장됩니다. 같은 이름의 파일은 덮어쓰지 않습니다.</p><label for="transfer-file">파일 선택 · 최대 50 MiB</label><input id="transfer-file" type="file"><label for="transfer-path">프로젝트 안의 저장 경로</label><input id="transfer-path" placeholder="assets/image.png"><p class="small-note">중단됐다면 같은 파일과 저장 경로를 선택해 이어서 전송하세요. 전송은 24시간 유지됩니다. AI 작업 중에는 수신한 파일의 최종 반영을 기다립니다.</p><div class="modal-actions"><button class="button primary" id="transfer-start">전송 시작 · 이어받기</button></div>');
    $('transfer-file').onchange=()=>{$('transfer-path').value=$('transfer-file').files[0]?.name||'';};
    $('transfer-start').onclick=async()=>{
      if(uploading)return;const file=$('transfer-file').files[0],name=$('transfer-path').value.trim();
      if(!file||!name||file.size>50*1024*1024){toast('50 MiB 이하 파일과 저장 경로를 확인하세요.');return;}
      uploading=true;$('transfer-start').disabled=true;
      let key;
      try{
        const buffer=await file.arrayBuffer();const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))].map(b=>b.toString(16).padStart(2,'0')).join('');
        key='hih-upload:'+getMe().id+':'+name+':'+hash;
        let info;const saved=localStorage.getItem(key);
        if(saved){try{info=await api('/api/uploads/'+saved);}catch{localStorage.removeItem(key);}}
        if(!info)info=await api('/api/uploads',{name,size:file.size,hash});localStorage.setItem(key,info.id);$('modal').close();
        while(info.offset<file.size){
          const chunk=new Uint8Array(buffer.slice(info.offset,info.offset+512*1024));let binary='';for(let i=0;i<chunk.length;i+=8192)binary+=String.fromCharCode(...chunk.subarray(i,i+8192));
          info=await api('/api/uploads/'+info.id+'/chunk',{offset:info.offset,data:btoa(binary)});$('upload-progress').textContent=`${name} · ${Math.round(info.offset/Math.max(1,file.size)*100)}% 전송`;
        }
        await api('/api/uploads/'+info.id+'/complete',{});localStorage.removeItem(key);$('upload-progress').textContent=`${name} · 저장 완료`;await refreshFiles();toast('호스트에 저장했습니다. AI에게 파일 경로를 알려주면 같은 세션에서 사용할 수 있습니다.');
      }catch(error){$('upload-progress').textContent=error.message+' 같은 파일을 다시 선택하면 이어서 처리합니다.';toast(error.message);}
      finally{uploading=false;if($('transfer-start'))$('transfer-start').disabled=false;}
    };
  };
  async function changes(id){
    try{
      const record=await api('/api/changes/'+id);
      modal(`<h2>작업 전후 파일 비교</h2><p>이 턴이 실행되는 동안 관찰한 변경입니다. 외부 편집기의 변경도 포함될 수 있습니다. 복구는 해당 파일만 되돌리며 대화 원본은 유지합니다.</p>${record.changes.length?record.changes.map(c=>`<details class="change-detail" open><summary>${e(c.path)} · ${e(({added:'추가',deleted:'삭제',modified:'수정'})[c.kind])}</summary><div class="change-grid"><div><strong>변경 전</strong><pre>${e(c.beforeView?.binary?'바이너리 또는 큰 파일':c.beforeView?.content??'(파일 없음)')}</pre></div><div><strong>변경 후</strong><pre>${e(c.afterView?.binary?'바이너리 또는 큰 파일':c.afterView?.content??'(파일 없음)')}</pre></div></div>${getMe().role==='owner'?`<button class="button small" data-restore-file="${e(c.path)}">이 파일을 변경 전으로 복구</button>`:''}</details>`).join(''):'<p>보관 범위에서 변경된 파일이 없습니다.</p>'}${record.skipped.length?`<p class="small-note">백업 크기 제한으로 제외: ${e(record.skipped.join(', '))}</p>`:''}`);
      document.querySelectorAll('[data-restore-file]').forEach(b=>b.onclick=async()=>{try{b.disabled=true;await api('/api/changes/'+id+'/restore',{path:b.dataset.restoreFile});toast('파일을 복구했습니다. 대화 기록은 유지됩니다.');await refreshFiles();refreshPreview();$('modal').close();}catch(error){b.disabled=false;toast(error.message);}});
    }catch(error){toast(error.message);}
  }
  return {
    devPreview:()=>devPreview,
    render(state,me){
      $('preview-settings').classList.toggle('hidden',me.role!=='owner');$('preview-live').disabled=!state.preview?.enabled;
      $('upload-file').classList.toggle('hidden',me.role==='observer');
      $('archived-sessions').classList.toggle('hidden',me.role!=='owner');
      $('file-events').textContent=(state.fileEvents||[]).slice(-20).reverse().map(event=>`${event.actor} · ${event.kind==='restore'?'복구':'업로드'} · ${event.path}`).join('\n')||'아직 파일 작업이 없습니다.';
      if(devPreview&&(!state.preview?.enabled||currentPort!==state.preview.targetPort))staticPreview();
      for(const turn of state.turns){
        const element=$('turn-'+turn.id);if(!element||element.dataset.projectDecorated)continue;element.dataset.projectDecorated='true';
        if(turn.fileChanges)element.insertAdjacentHTML('beforeend',`<button class="button small" data-changes="${e(turn.id)}">변경 파일 ${turn.fileChanges.length}개 · 비교와 복구</button>`);
        if(turn.historyError||turn.historySkipped?.length)element.insertAdjacentHTML('beforeend',`<p class="small-note">${e(turn.historyError||`백업 크기 제한으로 ${turn.historySkipped.length}개 파일 제외`)}</p>`);
        if(turn.usage){const total=turn.usage.total||turn.usage;const input=total.inputTokens??total.input_tokens,output=total.outputTokens??total.output_tokens;if(input!==undefined||output!==undefined)element.insertAdjacentHTML('beforeend',`<p class="small-note">${turn.usage.total?'세션 누적 토큰 (Codex 제공)':'Codex 제공 토큰'} · 입력 ${e(input??'확인 불가')} / 출력 ${e(output??'확인 불가')}</p>`);}
      }
      document.querySelectorAll('[data-changes]').forEach(b=>b.onclick=()=>changes(b.dataset.changes));
    },
  };
}
