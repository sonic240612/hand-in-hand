const STATUS_LABELS={queued:'차례 대기',syncing:'동일 세션 적용 중',running:'작업 중',completed:'완료',failed:'실패',interrupted:'확인 필요',cancelled:'취소됨'};
const DEFAULT_BUDGET=1_000_000;
const fold=value=>String(value??'').toLocaleLowerCase();
const clip=(value,size)=>String(value??'').slice(0,size);

// Traverse public text without stringifying whole tool payloads or decoding media.
function* publicText(value,context,depth=0){
  if(context.nodes--<=0||context.remaining<=0){context.truncated=true;return;}
  if(value===null||value===undefined)return;
  if(typeof value==='string'||typeof value==='number'||typeof value==='boolean'){
    const raw=String(value),text=raw.slice(0,context.remaining);
    context.remaining-=text.length;
    if(raw.length>text.length)context.truncated=true;
    yield text;
    return;
  }
  if(typeof value!=='object')return;
  if(depth>=32){context.truncated=true;return;}
  if(context.seen.has(value))return;
  context.seen.add(value);
  if(['image','input_image','image_url','audio','input_audio'].includes(value.type))return;
  for(const key in value){
    if(!Object.hasOwn(value,key))continue;
    if(context.remaining<=0||context.nodes<=0){context.truncated=true;break;}
    if(['blob','base64','image_url','audio_url'].includes(key))continue;
    const child=value[key];
    if(key==='data'&&typeof child==='string'&&child.length>256&&/^[A-Za-z0-9+/=\r\n]+$/.test(child))continue;
    yield* publicText(child,context,depth+1);
  }
}

function snippet(text,query){
  const at=query?fold(text).indexOf(query):0;
  const start=Math.max(0,at-55),end=Math.min(text.length,Math.max(at,0)+155);
  return `${start?'…':''}${text.slice(start,end).replace(/\s+/g,' ')}${end<text.length?'…':''}`;
}

function findTurn(turn,query,budget){
  if(!query)return {match:{kind:'지시',excerpt:snippet(String(turn.prompt??''),'')},truncated:false};
  const prompt=String(turn.prompt??'');
  if(fold(prompt).includes(query))return {match:{kind:'지시',excerpt:snippet(prompt,query)},truncated:false};
  for(const item of turn.items||[]){
    const text=String(item.text??'');
    if(fold(text).includes(query))return {match:{kind:'AI 응답',excerpt:snippet(text,query)},truncated:false};
  }
  const context={remaining:budget,nodes:10_000,seen:new WeakSet(),truncated:false};
  for(const tool of turn.tools||[]){
    const name=String(tool.name??'도구');
    if(fold(name).includes(query))return {match:{kind:'도구',excerpt:snippet(name,query)},truncated:context.truncated};
    for(const text of publicText(tool.result?.output??tool.result,context)){
      if(fold(text).includes(query))return {match:{kind:`도구 · ${clip(name,70)}`,excerpt:snippet(text,query)},truncated:context.truncated};
    }
    // Commands and paths are also visible in the tool's summary in the timeline.
    for(const text of publicText(tool.args,context)){
      if(fold(text).includes(query))return {match:{kind:`도구 · ${clip(name,70)}`,excerpt:snippet(text,query)},truncated:context.truncated};
    }
  }
  return {match:null,truncated:context.truncated};
}

export function searchTurns(turns,{query='',authorId='',status=''}={},options={}){
  const term=fold(String(query).trim()),limit=Math.max(1,options.limit??50),budget=Math.max(1,options.toolBudget??DEFAULT_BUDGET);
  const matches=[];let total=0,truncatedTurns=0;
  if(!term&&!authorId&&!status)return {matches,total,truncatedTurns};
  for(let index=turns.length-1;index>=0;index--){
    const turn=turns[index];
    if(authorId&&turn.authorId!==authorId||status&&turn.status!==status)continue;
    const signature=turn.committedRevision&&turn.completionHash?`${turn.committedRevision}:${turn.completionHash}:${turn.status}`:null;
    const cached=signature&&options.cache?.get(turn.id);
    const result=cached?.signature===signature&&cached?.query===term&&cached?.budget===budget?cached.result:findTurn(turn,term,budget);
    if(signature&&options.cache)options.cache.set(turn.id,{signature,query:term,budget,result});
    if(result.truncated)truncatedTurns++;
    if(!result.match)continue;
    total++;
    if(matches.length<limit)matches.push({id:turn.id,authorName:turn.authorName,status:turn.status,createdAt:turn.createdAt,...result.match});
  }
  return {matches,total,truncatedTurns};
}

function node(tag,className,text){
  const element=document.createElement(tag);
  if(className)element.className=className;
  if(text!==undefined)element.textContent=text;
  return element;
}

export function conversationSearch({getState}){
  const bar=document.querySelector('.conversation-bar');
  const trigger=node('button','text-button conversation-search-trigger','대화 검색');
  trigger.type='button';trigger.id='conversation-search-open';trigger.setAttribute('aria-expanded','false');trigger.setAttribute('aria-controls','conversation-search');
  const actions=node('div','conversation-search-actions'),guide=document.getElementById('guide');
  if(guide)actions.append(guide);
  actions.prepend(trigger);bar.append(actions);
  const panel=node('section','conversation-search hidden');panel.id='conversation-search';panel.setAttribute('aria-label','현재 세션 대화 검색');
  const top=node('div','conversation-search-top'),label=node('label','','검색어');label.htmlFor='conversation-search-query';
  const input=node('input');input.id='conversation-search-query';input.type='search';input.placeholder='지시, AI 응답, 도구 결과에서 찾기';input.maxLength=200;input.autocomplete='off';
  const close=node('button','text-button','닫기');close.type='button';close.setAttribute('aria-label','대화 검색 닫기');
  top.append(label,input,close);
  const filters=node('div','conversation-search-filters');
  const authorLabel=node('label','','작성자'),author=node('select');author.id='conversation-search-author';authorLabel.htmlFor=author.id;
  const statusLabel=node('label','','상태'),status=node('select');status.id='conversation-search-status';statusLabel.htmlFor=status.id;
  const allStatus=node('option','','모든 상태');allStatus.value='';status.append(allStatus);
  for(const [value,name]of Object.entries(STATUS_LABELS)){const option=node('option','',name);option.value=value;status.append(option);}
  const reset=node('button','text-button','초기화');reset.type='button';
  filters.append(authorLabel,author,statusLabel,status,reset);
  const summary=node('p','conversation-search-summary');summary.setAttribute('role','status');summary.setAttribute('aria-live','polite');
  const results=node('ol','conversation-search-results');results.setAttribute('aria-label','검색 결과');
  const limitNote=node('p','conversation-search-limit');
  panel.append(top,filters,summary,results,limitNote);bar.after(panel);
  let current=getState(),sessionId=current?.id,opened=false,composing=false,timer,selectedId='',authorStamp='',resultStamp='';
  const cache=new Map();
  function clearHighlight(){document.querySelectorAll('.turn.search-selected').forEach(turn=>turn.classList.remove('search-selected'));}
  function highlight(){clearHighlight();if(selectedId)document.getElementById('turn-'+selectedId)?.classList.add('search-selected');}
  function jump(id){
    const turn=document.getElementById('turn-'+id),timeline=document.getElementById('timeline');
    if(!turn||!timeline){summary.textContent='현재 세션에서 이 턴을 찾을 수 없습니다.';return;}
    selectedId=id;highlight();turn.tabIndex=-1;
    timeline.scrollTo({top:timeline.scrollTop+turn.getBoundingClientRect().top-timeline.getBoundingClientRect().top-12,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    turn.focus({preventScroll:true});
  }
  function markedText(element,text,term){
    if(!term){element.append(document.createTextNode(text));return;}
    const at=fold(text).indexOf(term);
    if(at<0){element.append(document.createTextNode(text));return;}
    element.append(document.createTextNode(text.slice(0,at)),node('mark','',text.slice(at,at+term.length)),document.createTextNode(text.slice(at+term.length)));
  }
  function refreshAuthors(){
    const names=new Map((current?.participants||[]).map(person=>[person.id,person.name]));
    for(const turn of current?.turns||[])if(!names.has(turn.authorId))names.set(turn.authorId,turn.authorName);
    const stamp=JSON.stringify([...names]);if(stamp===authorStamp)return;authorStamp=stamp;
    const selected=author.value,all=node('option','','모든 작성자');all.value='';author.replaceChildren(all);
    for(const [id,name]of names){const option=node('option','',name);option.value=id;author.append(option);}
    if(names.has(selected))author.value=selected;
  }
  function update(){
    if(!opened||composing)return;
    refreshAuthors();
    const query=input.value.trim(),filtered=!!(query||author.value||status.value);
    const found=searchTurns(current?.turns||[],{query,authorId:author.value,status:status.value},{cache});
    const stamp=JSON.stringify([query,author.value,status.value,found]);
    if(stamp!==resultStamp){
      resultStamp=stamp;
      const focused=document.activeElement?.dataset.searchTurn;
      const rows=found.matches.map(match=>{
        const row=node('li'),button=node('button','conversation-search-result');button.type='button';button.dataset.searchTurn=match.id;
        const heading=node('span','conversation-search-result-heading');
        heading.append(node('strong','',match.authorName),node('span','',STATUS_LABELS[match.status]||match.status));
        const date=new Date(match.createdAt);if(!Number.isNaN(date.valueOf()))heading.append(node('time','',date.toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})));
        const excerpt=node('span','conversation-search-excerpt');excerpt.append(node('span','conversation-search-kind',match.kind+' · '));markedText(excerpt,match.excerpt,fold(query));
        button.append(heading,excerpt);button.onclick=()=>jump(match.id);row.append(button);return row;
      });
      results.replaceChildren(...rows);
      if(focused)[...results.querySelectorAll('[data-search-turn]')].find(button=>button.dataset.searchTurn===focused)?.focus({preventScroll:true});
      summary.textContent=!filtered?'검색어를 입력하거나 작성자·상태를 선택하세요.':!found.total?'일치하는 대화가 없습니다. 다른 검색어나 필터를 사용해 보세요.':`${found.total}개 턴이 일치합니다. ${found.total>found.matches.length?`최근 ${found.matches.length}개를 표시합니다. 검색 조건을 좁혀 주세요.`:'결과를 누르면 해당 대화로 이동합니다.'}`;
      limitNote.textContent=found.truncatedTurns?`큰 도구 결과는 턴당 1,000,000자까지 검색합니다. ${found.truncatedTurns}개 턴에서 일부 출력을 생략했습니다.`:'';
      if(selectedId&&!found.matches.some(match=>match.id===selectedId))selectedId='';
    }
    highlight();
  }
  function resetFilters(){input.value='';author.value='';status.value='';selectedId='';resultStamp='';clearHighlight();update();}
  function open(){opened=true;panel.classList.remove('hidden');trigger.setAttribute('aria-expanded','true');current=getState()||current;update();input.focus();}
  function hide(){opened=false;clearTimeout(timer);panel.classList.add('hidden');trigger.setAttribute('aria-expanded','false');selectedId='';clearHighlight();trigger.focus();}
  trigger.onclick=()=>opened?hide():open();close.onclick=hide;
  input.addEventListener('compositionstart',()=>{composing=true;clearTimeout(timer);});
  input.addEventListener('compositionend',()=>{composing=false;update();});
  input.addEventListener('input',()=>{clearTimeout(timer);if(!composing)timer=setTimeout(update,150);});
  author.onchange=status.onchange=()=>{selectedId='';update();};reset.onclick=()=>{resetFilters();input.focus();};
  panel.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();hide();}});
  return {open,render(next){
    current=next;
    if(sessionId!==next.id){sessionId=next.id;authorStamp='';cache.clear();resetFilters();}
    update();
  }};
}
