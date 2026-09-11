import {randomUUID} from 'node:crypto';

const commandMethods=new Set(['item/commandExecution/requestApproval','item/fileChange/requestApproval','execCommandApproval','applyPatchApproval']);
const inputMethods=new Set(['item/tool/requestUserInput','tool/requestUserInput']);
export function interactionKind(method) {
  if(commandMethods.has(method))return 'approval';
  if(inputMethods.has(method))return 'questions';
  if(method==='item/permissions/requestApproval')return 'permissions';
  if(method==='mcpServer/elicitation/request')return 'elicitation';
  throw new Error('지원하지 않는 Codex 요청: '+method);
}
export function interactionResult(method,params,reply) {
  const kind=interactionKind(method),action=reply.action;
  if(kind==='approval') {
    if(['execCommandApproval','applyPatchApproval'].includes(method)) {
      const decision={accept:'approved',acceptForSession:'approved_for_session',decline:'abort',cancel:'abort'}[action];
      if(!decision)throw new Error('허용하지 않는 승인 응답입니다.');
      return {decision};
    }
    const allowed=params.availableDecisions?.filter(d=>typeof d==='string')||['accept','acceptForSession','decline','cancel'];
    const decision=action==='decline'&&!allowed.includes('decline')&&allowed.includes('cancel')?'cancel':action;
    if(!allowed.includes(decision))throw new Error('허용하지 않는 승인 응답입니다.');
    return {decision};
  }
  if(kind==='permissions') {
    if(!['accept','decline'].includes(action))throw new Error('승인 또는 거절을 선택하세요.');
    return {permissions:action==='accept'?params.permissions:{},scope:'turn'};
  }
  if(kind==='questions') {
    const answers={};
    for(const question of params.questions||[]) {
      const value=reply.answers?.[question.id];
      if(!Array.isArray(value)||!value.length||value.some(v=>typeof v!=='string'||!v.trim()||v.length>20_000))throw new Error('각 질문의 답변을 입력하세요.');
      answers[question.id]={answers:value};
    }
    return {answers};
  }
  if(!['accept','decline','cancel'].includes(action))throw new Error('Invalid elicitation action.');
  return {action,content:action==='accept'?(reply.content??null):null};
}

export class Interactions {
  constructor({ownerId,save}){this.ownerId=ownerId;this.save=save;this.pending=new Map();}
  open(turn,{requestId,method,params={}}) {
    const kind=interactionKind(method),key=`${turn.id}:${requestId}`;
    const existing=[...this.pending.values()].find(p=>p.key===key);if(existing)return {id:existing.id};
    if(JSON.stringify(params).length>250_000)throw new Error('Codex 확인 요청이 너무 큽니다.');
    const id=randomUUID(),actorId=['approval','permissions'].includes(kind)?this.ownerId():turn.authorId;
    const record={id,key,turnId:turn.id,authorId:turn.authorId,actorId,method,kind,params,status:'pending'};
    this.pending.set(id,record);
    turn.interactions||=[];turn.interactions.push({id,kind,actorId,status:'pending',createdAt:new Date().toISOString()});this.save();return {id};
  }
  detail(id,memberId) {
    const p=this.pending.get(id);if(!p||p.actorId!==memberId)throw Object.assign(new Error('이 요청에 응답할 권한이 없습니다.'),{status:403});
    return {id:p.id,kind:p.kind,method:p.method,params:p.params,status:p.status};
  }
  reply(turn,id,memberId,reply) {
    this.detail(id,memberId);const p=this.pending.get(id);
    if(p.turnId!==turn.id||p.status!=='pending')throw new Error('이미 응답했거나 만료된 요청입니다.');
    p.result=interactionResult(p.method,p.params,reply);p.status='answered';
    Object.assign(turn.interactions.find(i=>i.id===id),{status:'answered',answeredAt:new Date().toISOString()});this.save();
  }
  poll(turn,id) {
    const p=this.pending.get(id);if(!p||p.turnId!==turn.id)throw new Error('Expired Codex request.');
    return p.status==='answered'?{ready:true,result:p.result}:{ready:false};
  }
  finish(turn) {
    for(const [id,p] of this.pending)if(p.turnId===turn.id){this.pending.delete(id);const i=turn.interactions?.find(i=>i.id===id);if(i?.status==='pending')i.status='cancelled';}
  }
}
