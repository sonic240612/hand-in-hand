// Per-tab drafts and a durable request ID keep a lost HTTP response from
// becoming a second instruction after refresh. Credentials are stored apart.
export class ComposerJournal {
  constructor(storage,sessionId,memberId,uuid=()=>crypto.randomUUID()){
    this.storage=storage;this.sessionId=sessionId;this.memberId=memberId;this.uuid=uuid;
    this.key=`hih-draft-v1:${sessionId}:${memberId}`;this.data={text:'',pending:null};
    const saved=storage.getItem(this.key);
    if(saved){const value=JSON.parse(saved);if(typeof value.text!=='string'||value.text.length>20000||value.pending&&(value.pending.sessionId!==sessionId||typeof value.pending.prompt!=='string'||value.pending.prompt.length>20000||typeof value.pending.requestId!=='string'))throw new Error('저장된 지시를 확인할 수 없습니다.');this.data=value;}
  }
  save(){this.storage.setItem(this.key,JSON.stringify(this.data));}
  edit(text){this.data.text=text.slice(0,20000);this.save();}
  prepare(){
    if(this.data.pending)return this.data.pending;
    const prompt=this.data.text.trim();if(!prompt)throw new Error('지시를 입력하세요.');
    const previous=this.data.pending;this.data.pending={sessionId:this.sessionId,prompt,requestId:this.uuid()};
    try{this.save();}catch(error){this.data.pending=previous;throw error;}return this.data.pending;
  }
  acknowledge(requestId){
    if(this.data.pending?.requestId!==requestId)return false;
    const before={...this.data};if(this.data.text.trim()===this.data.pending.prompt)this.data.text='';this.data.pending=null;
    try{this.save();}catch(error){this.data=before;throw error;}return true;
  }
  reconcile(turns){const pending=this.data.pending;if(pending&&turns.some(t=>t.authorId===this.memberId&&t.requestId===pending.requestId))return this.acknowledge(pending.requestId);return false;}
}

export class BrowserCredentials {
  constructor(tabStorage,deviceStorage){this.tab=tabStorage;this.device=deviceStorage;}
  read(){return this.tab.getItem('hih-token')||this.device.getItem('hih-remembered-token');}
  remembered(token){return !!token&&this.device.getItem('hih-remembered-token')===token;}
  set(token,remember=false){this.tab.setItem('hih-token',token);if(remember)this.device.setItem('hih-remembered-token',token);else this.device.removeItem('hih-remembered-token');}
  clear(){this.tab.removeItem('hih-token');this.device.removeItem('hih-remembered-token');}
}
