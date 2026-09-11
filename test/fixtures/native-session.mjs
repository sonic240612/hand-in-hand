// Structural fixtures based on the Codex 0.154.0 native JSONL format; no real session data.
export const nativeId='11111111-1111-4111-8111-111111111111';
export const line=value=>JSON.stringify(value)+'\n';
export const event=(type,extra={})=>line({type:'event_msg',payload:{type,...extra}});
export const message=(role,text)=>line({type:'response_item',payload:{type:'message',role,content:[{type:role==='assistant'?'output_text':'input_text',text}]}});
export const original=line({type:'session_meta',payload:{id:nativeId,context_window:{window_id:'window-0'}}})+
  message('user','Remember the violet project.')+message('assistant','Remembered.');
export const compact=(overrides={})=>line({type:'compacted',payload:{message:'',replacement_history:[{type:'message',role:'user',content:[{type:'input_text',text:'Remember the violet project.'}]},{type:'compaction',encrypted_content:'opaque-native-state'}],window_id:'window-1',previous_window_id:'window-0',window_number:1,...overrides}});
export const interrupted=(middle='')=>event('thread_settings_applied')+event('task_started',{turn_id:'native-turn'})+middle+event('turn_aborted',{turn_id:'native-turn',reason:'interrupted'});
export const abortNotice=(overrides={})=>line({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>'}],internal_chat_message_metadata_passthrough:{turn_id:'native-turn',content_item_kinds:['generic.turn_aborted']},...overrides}});
