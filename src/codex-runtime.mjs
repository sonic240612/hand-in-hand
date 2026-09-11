import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodexRpc } from './codex-rpc.mjs';

export function runtimeEnvironment(source, runtimeHome) {
  const env={...source};
  // A participant's shell must not select API billing or a shared state database.
  for (const key of Object.keys(env)) if (/^(OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN|OPENAI_FEDERATION_RULE_ID|OPENAI_IDENTITY_TOKEN_FILE|OPENAI_WORKLOAD_IDENTITY_CONTEXT|CODEX_HOME|CODEX_SQLITE_HOME)$/i.test(key)) delete env[key];
  return {...env,CODEX_HOME:runtimeHome,CODEX_SQLITE_HOME:runtimeHome};
}

export async function readChatgptTokens(sourceHome, expectedAccountId) {
  let auth;
  try { auth=JSON.parse(await readFile(path.join(sourceHome,'auth.json'),'utf8')); }
  catch { throw new Error('파일에 저장된 ChatGPT 로그인이 필요합니다. codex -c cli_auth_credentials_store="file" login 후 다시 연결하세요.'); }
  if(auth.auth_mode!=='chatgpt' || auth.OPENAI_API_KEY || !auth.tokens?.access_token || !auth.tokens?.account_id) throw new Error('ChatGPT 계정 로그인만 지원합니다. 추가 과금 방지를 위해 API 키 인증은 사용하지 않습니다.');
  if(expectedAccountId && auth.tokens.account_id!==expectedAccountId) throw new Error('Codex 인증 계정이 변경되었습니다. 다시 연결하세요.');
  return {accessToken:auth.tokens.access_token,chatgptAccountId:auth.tokens.account_id};
}

// Native logs, SQLite and writer locks live in this runner's private home.
// The official login remains in the participant's own Codex home. Only its
// access token is passed over local stdio, held in memory, and never sent to the host.
export class CodexRuntime extends CodexRpc {
  constructor({dataDir,cwd,executable,env=process.env,sourceHome=env.CODEX_HOME||path.join(os.homedir(),'.codex')}={}) {
    const runtimeHome=path.resolve(dataDir,'codex-runtime');
    super({cwd,executable,env:runtimeEnvironment(env,runtimeHome),config:{
      'model_provider':'openai', 'forced_login_method':'chatgpt',
      'cli_auth_credentials_store':'ephemeral', 'sqlite_home':runtimeHome,
    }});
    this.sourceHome=sourceHome;
    this.sourceOptions={cwd,executable,env};
    this.on('request',async msg=>{
      if(msg.method!=='account/chatgptAuthTokens/refresh') return;
      try { this.send({id:msg.id,result:await this.refreshLogin()}); }
      catch { if(!this.closed)this.send({id:msg.id,error:{code:-32000,message:'ChatGPT 로그인 갱신에 실패했습니다. codex login 후 다시 연결하세요.'}}); }
    });
  }
  async initialize() {
    const result=await super.initialize();
    const tokens=await readChatgptTokens(this.sourceHome);
    this.accountId=tokens.chatgptAccountId;
    await this.request('account/login/start',{type:'chatgptAuthTokens',...tokens});
    return result;
  }
  async refreshLogin() {
    // Let official Codex update its own login; do not implement OAuth or duplicate refresh tokens.
    const source=new CodexRpc(this.sourceOptions);
    try {
      await source.initialize();
      const {account}=await source.request('account/read',{refreshToken:true});
      if(account?.type!=='chatgpt') throw new Error('ChatGPT login required.');
      return await readChatgptTokens(this.sourceHome,this.accountId);
    } finally { await source.close(); }
  }
}

export async function createCodexRuntime(options) {
  await mkdir(path.resolve(options.dataDir,'codex-runtime'),{recursive:true,mode:0o700});
  return new CodexRuntime(options);
}
