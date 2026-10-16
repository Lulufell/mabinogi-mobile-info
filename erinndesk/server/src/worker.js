import { DurableObject } from 'cloudflare:workers';
import { verifyEnvelope, validateAccess, denial } from './operations.js';
import { json, reply, hash, verifyDiscord, validateName, formatItems } from './protocol.js';

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return json({ok:true,service:'Erinn Desk Remote',version:1,commit:env.DEPLOY_COMMIT || 'local'});
    const hub = env.HUB.get(env.HUB.idFromName('pilot-v1'));
    if (path === '/policy' && request.method === 'GET') return hub.fetch(new Request('https://hub/policy'));
    if (path.startsWith('/admin/')) {
      if (!env.OPS_ADMIN_TOKEN || env.OPS_ADMIN_TOKEN.length<32) return json({error:'관리자 인증 설정이 필요합니다.'},503);
      const supplied=(request.headers.get('Authorization')||'').replace(/^Bearer /,'');
      if (supplied.length>256 || await hash(supplied)!==await hash(env.OPS_ADMIN_TOKEN))return json({error:'unauthorized'},401);
      return hub.fetch(request);
    }
    if (path === '/discord' && request.method === 'POST') {
      if (Number(request.headers.get('Content-Length') || 0) > 32768) return json({error:'too_large'},413);
      const body = await request.text();
      if (body.length > 32768) return json({error:'too_large'},413);
      if (!await verifyDiscord(request, body, env.DISCORD_PUBLIC_KEY)) return json({error:'invalid_signature'},401);
      let data;try { data=JSON.parse(body); } catch { return json({error:'invalid_json'},400); }
      if (data.type === 1) return json({type:1});
      if (data.application_id !== env.DISCORD_APPLICATION_ID || data.guild_id !== env.DISCORD_GUILD_ID) return reply('에린 데스크 전용 디스코드 서버에서 사용하세요.');
      return hub.fetch(new Request('https://hub/discord',{method:'POST',body:JSON.stringify(data)}));
    }
    if (['/register','/register-test'].includes(path) && request.method === 'POST') {
      const ip=request.headers.get('CF-Connecting-IP');
      if (!ip && !env.LOCAL_TEST) return json({error:'missing_ip'},403);
      return hub.fetch(new Request('https://hub'+path,{method:'POST',headers:{'X-Client-Hash':await hash(ip || 'local'),'X-Erinn-Version':request.headers.get('X-Erinn-Version')||''}}));
    }
    if (path === '/oauth/callback' && request.method === 'GET') return hub.fetch(request);
    if (path === '/agent' && request.method === 'GET') return hub.fetch(request);
    if (/^\/capture\/\d{1,25}$/.test(path) && request.method === 'POST') return hub.fetch(request);
    return json({error:'not_found'},404);
  }
};

export class RemoteHub extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.store=ctx.storage; }
  sockets(id) { return this.ctx.getWebSockets(id); }
  send(id, value) { for(const ws of this.sockets(id)) { try { ws.send(JSON.stringify(value)); } catch {} } }
  async limited(key, maximum, windowMs) {
    const now=Date.now();let value=await this.store.get(key);
    if (!value || value.until <= now) value={count:0,until:now+windowMs};
    if(value.count>=maximum)return true;
    value.count++;await this.store.put(key,value);await this.schedule();return false;
  }
  async policyState() {
    const value=await this.store.get('ops:current');
    return value ? {...value,policy:JSON.parse(value.envelope.payload)} : {policy:null,access:{mode:'all',users:[]},revision:0};
  }
  async denied(feature,user,clientVersion,agent=null) {
    const state=await this.policyState();
    if(agent?.oauthTest){
      const testers=(this.env.OAUTH_TEST_USERS||'').split(',').map(v=>v.trim()).filter(v=>/^\d{17,22}$/.test(v));
      if(!testers.length || (user&&!testers.includes(user)))return 'OAuth 테스트가 허용된 계정만 연결할 수 있습니다.';
      clientVersion=undefined;
    }
    return denial(state.policy,state.access,feature,user,clientVersion);
  }
  async operations(request,path) {
    if(path==='/policy'&&request.method==='GET') {
      const state=await this.policyState();return state.envelope?json(state.envelope):json({error:'policy_not_configured'},503);
    }
    if(path==='/admin/state'&&request.method==='GET')return json(await this.policyState());
    if(path==='/admin/history'&&request.method==='GET') {
      const records=await this.store.list({prefix:'ops:history:'});return json([...records.values()].sort((a,b)=>b.revision-a.revision));
    }
    if(path!=='/admin/state'||request.method!=='PUT')return json({error:'not_found'},404);
    const reader=request.body?.getReader();if(!reader)return json({error:'invalid_body'},400);
    let text='',size=0;const decoder=new TextDecoder();
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>262144){await reader.cancel();return json({error:'too_large'},413);}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();
    return this.ctx.blockConcurrencyWhile(async()=>{
      try {
        const body=JSON.parse(text),state=await this.policyState();
        if(body.expectedRevision!==state.revision)return json({error:'다른 변경이 반영되었습니다. 최신 설정을 다시 불러오세요.'},409);
        const policy=await verifyEnvelope(body.envelope,this.env.OPS_PUBLIC_KEY),access=validateAccess(body.access);
        if(policy.revision!==state.revision+1)throw Error('정책 번호는 현재 번호보다 1 커야 합니다.');
        for(const [v,r]of Object.entries(policy.releases)){
          const prior=await this.store.get('ops:release:'+v);
          if(prior&&(prior.sha256!==r.sha256||prior.size!==r.size))throw Error('이미 게시한 버전의 파일은 교체할 수 없습니다. 새 버전을 사용하세요.');
        }
        const next={revision:policy.revision,envelope:body.envelope,access,changedAt:Date.now()};
        await this.store.transaction(async tx=>{
          if(state.envelope)await tx.put('ops:history:'+String(state.revision).padStart(12,'0'),{revision:state.revision,envelope:state.envelope,access:state.access,changedAt:state.changedAt});
          for(const [v,r]of Object.entries(policy.releases))await tx.put('ops:release:'+v,{sha256:r.sha256,size:r.size});
          await tx.put('ops:current',next);
          const records=await tx.list({prefix:'ops:history:'});for(const key of [...records.keys()].sort().slice(0,Math.max(0,records.size-100)))await tx.delete(key);
        });
        // Cancel denied work before accepting any more sensitive results.
        for(const [key,pending]of await this.store.list({prefix:'query:'})){
          if(!await this.authorized(pending)){
            const agent=await this.store.get('agent:'+pending.agent);
            const reason=await this.denied(pending.kind==='capture'?'capture':'items',pending.user,agent?.version||'',agent);
            await this.complete(key,pending,reason||'운영 설정이 변경되어 요청을 취소했습니다.');
          }
        }
        // Notify existing clients; every command/result independently rechecks policy.
        for(const ws of this.ctx.getWebSockets()){try{ws.send(JSON.stringify({type:'policy_changed',revision:next.revision}));}catch{}}
        return json({ok:true,revision:next.revision});
      }catch(e){return json({error:e.message||'운영 설정을 확인하세요.'},400);}
    });
  }
  async fetch(request) {
    const path=new URL(request.url).pathname;
    if(path==='/policy'||path.startsWith('/admin/'))return this.operations(request,path);
    if(/^\/capture\/\d{1,25}$/.test(path)&&request.method==='POST')return this.captureUpload(request);
    if(path==='/oauth/callback'&&request.method==='GET')return this.oauthCallback(request);
    if(path==='/register'||path==='/register-test')return this.ctx.blockConcurrencyWhile(async()=>{
      const oauthTest=path==='/register-test';
      const reason=await this.denied('link',null,request.headers.get('X-Erinn-Version')||'',{oauthTest});if(reason)return json({error:reason},403);
      if(await this.limited('registration-global',30,60000))return json({error:'registration_rate_limited'},429);
      if(await this.limited('reg:'+request.headers.get('X-Client-Hash'),5,3600000))return json({error:'registration_rate_limited'},429);
      const id=crypto.randomUUID(),secret=crypto.randomUUID()+crypto.randomUUID();
      const now=Date.now(),until=now+30*60000;
      await this.store.put('agent:'+id,{oauthTest,hash:await hash(secret),created:now,registrationUntil:until,version:request.headers.get('X-Erinn-Version')||''});
      await this.store.put('unapproved:'+id,{until});await this.schedule();
      return json({id,secret});
    });
    if(path==='/agent') {
      return this.ctx.blockConcurrencyWhile(async()=>{
      if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return json({error:'websocket_required'},426);
      const auth=request.headers.get('Authorization') || '',match=/^Bearer ([a-f0-9-]{36}):([a-f0-9-]{72})$/.exec(auth);
      const agent=match && await this.store.get('agent:'+match[1]);
      if(!agent || await hash(match[2])!==agent.hash)return json({error:'unauthorized'},401);
      if(await this.expireRegistration(match[1],agent))return json({error:'registration_expired'},401);
      agent.version=request.headers.get('X-Erinn-Version')||'';
      const session=crypto.randomUUID();agent.session=session;
      await this.store.put('agent:'+match[1],agent);
      for(const old of this.sockets(match[1]))old.close(4000,'Replaced');
      const pair=new WebSocketPair(),client=pair[0],server=pair[1];
      this.ctx.acceptWebSocket(server,[match[1]]);server.serializeAttachment({id:match[1],session});
      server.send(JSON.stringify({type:'connected',linked:agent.user ? {id:agent.user,name:agent.userName} : null}));
      const pending=await this.store.get('pending:'+match[1]);
      if(pending?.until>Date.now())server.send(JSON.stringify({type:'approval',...pending}));
      return new Response(null,{status:101,webSocket:client});
      });
    }
    if(path==='/discord')return this.ctx.blockConcurrencyWhile(async()=>this.discord(await request.json()));
    return json({error:'not_found'},404);
  }
  async discord(data) {
    if(data.type!==2)return reply('지원하지 않는 요청입니다.');
    const user=data.member?.user || data.user;
    if(!user?.id || !data.id || !data.token)return reply('사용자 정보를 확인하지 못했습니다.');
    const replay='interaction:'+data.id,prior=await this.store.get(replay);
    if(prior)return json(prior.body);
    const finish=async response=>{await this.store.put(replay,{body:await response.clone().json(),until:Date.now()+900000});return response;};
    if(await this.limited('rate:'+user.id,10,60000))return finish(reply('1분에 최대 10번 사용할 수 있습니다. 잠시 후 다시 요청하세요.'));
    const options=Object.fromEntries((data.data?.options || []).map(o=>[o.name,o.value])),command=data.data?.name;
    if(!['연결','아이템','연결상태','스크린샷','연결해제'].includes(command))return finish(reply('지원하지 않는 명령입니다.'));
    const knownLink=await this.store.get('user:'+user.id),knownAgent=knownLink&&await this.store.get('agent:'+knownLink.agent);
    if(command!=='연결해제'){const reason=await this.denied(command==='연결'?'link':command==='스크린샷'?'capture':command==='아이템'?'items':'discord',user.id,undefined,knownAgent);if(reason)return finish(reply(reason));}
    if(command==='연결') {
      if(typeof options['코드']!=='string' || !/^[A-Z2-9]{10}$/.test(options['코드'].toUpperCase()))return finish(reply('PC의 에린 데스크에서 새 연결 코드를 생성해 입력하세요.'));
      const key='code:'+options['코드'].toUpperCase(),code=await this.store.get(key);
      if(!code || code.until<Date.now())return finish(reply('연결 코드가 만료되었거나 올바르지 않습니다. PC에서 다시 생성하세요.'));
      const candidate=await this.store.get('agent:'+code.agent);const reason=await this.denied('link',user.id,candidate?.version||'',candidate);if(reason)return finish(reply(reason));
      const existing=await this.store.get('pending:'+code.agent);
      if(existing?.until>Date.now())return finish(reply('PC에서 이전 연결 요청을 확인하고 있습니다. 잠시 후 다시 시도하세요.'));
      if(!this.sockets(code.agent).length)return finish(reply('PC 연결이 끊겼습니다. 앱 연결 상태를 확인하세요.'));
      const pending={nonce:crypto.randomUUID(),user:user.id,name:user.global_name || user.username,until:Date.now()+300000};
      await this.store.put('pending:'+code.agent,pending);await this.store.delete(key);
      this.send(code.agent,{type:'approval',...pending});
      return finish(reply('PC의 에린 데스크에서 계정을 확인하고 연결을 승인하세요. 승인 후 /연결상태로 확인할 수 있습니다.'));
    }
    const link=await this.store.get('user:'+user.id);
    const linkedAgent=link&&await this.store.get('agent:'+link.agent);
    if(!link||linkedAgent?.user!==user.id)return finish(reply('연결된 PC가 없습니다. PC에서 코드를 생성한 뒤 /연결을 사용하세요.'));
    if(command==='연결해제') {await this.unlink(link.agent);return finish(reply('PC 연결을 해제했습니다.'));}
    const policyReason=await this.denied(command==='스크린샷'?'capture':command==='아이템'?'items':'discord',user.id,linkedAgent.version||'',linkedAgent);if(policyReason)return finish(reply(policyReason));
    if(command==='연결상태')return finish(reply(this.sockets(link.agent).length?'PC와 연결되어 있습니다. /아이템으로 수량을 조회하세요.':'등록된 PC가 오프라인입니다. 게임과 에린 데스크를 켜 주세요.'));
    const screenshot=command==='스크린샷';
    if(!screenshot&&(command!=='아이템' || !validateName(options['이름'])))return finish(reply('품목 이름을 1~120자로 입력하세요.'));
    if(!this.sockets(link.agent).length)return finish(reply('PC가 오프라인입니다. 게임과 에린 데스크를 켜 주세요.'));
    const busy=await this.store.get('busy:'+link.agent);
    if(busy?.until>Date.now())return finish(reply('PC에서 다른 수량 조회가 진행 중입니다. 잠시 후 다시 요청하세요.'));
    if(screenshot&&(await this.store.get('capture-success:'+link.agent))?.until>Date.now())return finish(reply('게임 화면 캡처는 PC당 10분에 한 번 사용할 수 있습니다.'));
    const pending={agent:link.agent,user:user.id,linkVersion:linkedAgent.linkVersion??null,application:data.application_id,token:data.token,kind:screenshot?'capture':'items',until:Date.now()+45000};
    await this.store.put('query:'+data.id,pending);await this.store.put('busy:'+link.agent,{id:data.id,until:pending.until});
    await this.schedule();
    this.send(link.agent,{type:screenshot?'capture':'query',id:data.id,user:user.id,...(!screenshot?{name:options['이름'].trim()}:{}),until:pending.until});
    return finish(json({type:5,data:{flags:64}}));
  }
  oauthConfigured(){
    try{const u=new URL(this.env.OAUTH_REDIRECT_URI);return Boolean(this.env.DISCORD_CLIENT_SECRET&&u.protocol==='https:'&&u.pathname==='/oauth/callback'&&!u.search&&!u.hash&&!u.username&&!u.password);}catch{return false;}
  }
  async oauthStart(id,agent,ws){
    const fail=message=>ws.send(JSON.stringify({type:'error',message}));
    if(!agent.oauthTest)return fail('OAuth 테스트 빌드에서만 사용할 수 있습니다.');
    if(!this.oauthConfigured())return fail('디스코드 로그인 인증이 서버에 설정되지 않았습니다.');
    const reason=await this.denied('link',agent.user,agent.version||'',agent);if(reason)return fail(reason);
    if(await this.limited('pair-rate:'+id,5,60000))return fail('잠시 후 다시 연결해 주세요.');
    for(const [key,value]of await this.store.list({prefix:'oauth:'}))if(value.agent===id)await this.store.delete(key);
    await this.store.delete('oauth-ready:'+id);
    const state=crypto.randomUUID()+crypto.randomUUID(),until=Date.now()+300000;
    await this.store.put('oauth:'+state,{agent:id,session:agent.session,until});await this.store.put('oauth-flow:'+id,{state,until});await this.schedule();
    const url=new URL('https://discord.com/oauth2/authorize');url.search=new URLSearchParams({client_id:this.env.DISCORD_APPLICATION_ID,response_type:'code',redirect_uri:this.env.OAUTH_REDIRECT_URI,scope:'identify',state,prompt:'consent'}).toString();
    ws.send(JSON.stringify({type:'oauth-url',url:url.href}));
  }
  async oauthCallback(request){
    const html=(text,status=200,kind='')=>oauthResultPage(text,status,kind);
    if(!this.oauthConfigured())return html('인증 설정이 준비되지 않았습니다.',503);
    const url=new URL(request.url),state=url.searchParams.get('state')||'';
    if(!/^[a-f0-9-]{72}$/.test(state))return html('올바르지 않은 인증 요청입니다.',400);
    const pending=await this.ctx.blockConcurrencyWhile(async()=>{const value=await this.store.get('oauth:'+state);await this.store.delete('oauth:'+state);return value;});
    if(!pending||pending.until<=Date.now())return html('인증 요청이 만료되었습니다. 앱에서 다시 시작하세요.',400);
    const agent=await this.store.get('agent:'+pending.agent);
    if(!agent||agent.session!==pending.session||!this.sockets(pending.agent).length)return html('앱 연결이 변경되었습니다. 앱에서 다시 시작하세요.',409);
    const fail=(message,kind='')=>{this.send(pending.agent,{type:'error',message});return html(message,400,kind);};
    if(url.searchParams.has('error'))return fail('디스코드 로그인이 취소되었습니다.\n다시 연결하려면 앱에서 로그인을 시작해 주세요.','cancel');
    const code=url.searchParams.get('code');if(!code||code.length>2048)return fail('인증 코드를 확인하지 못했습니다.');
    let token,stage='token_request';
    const requestHeaders={'User-Agent':'DiscordBot (https://github.com/Lulufell/mabinogi-mobile-info, 1.0)'};
    const rejected=async(response,phase)=>{
      let body;try{body=await response.json();}catch{}
      const known=new Set(['invalid_client','invalid_grant','invalid_request','unauthorized_client','invalid_scope','unsupported_grant_type']);
      const code=known.has(body?.error)?body.error:null;
      const detail=code==='invalid_client'?'서버의 Discord Application ID와 OAuth2 Client Secret을 확인하세요.':code==='invalid_grant'?'인증 코드가 만료되었거나 사용되었습니다. 앱에서 새 로그인을 시작하세요.':response.status===429?'디스코드 요청 한도에 도달했습니다. 잠시 후 다시 시도하세요.':'잠시 후 앱에서 다시 시도하세요.';
      return fail('디스코드 인증 실패 ['+phase+' / HTTP '+response.status+(code?' / '+code:'')+']. '+detail);
    };
    try{
      const response=await fetch('https://discord.com/api/v10/oauth2/token',{method:'POST',headers:{...requestHeaders,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:this.env.DISCORD_APPLICATION_ID,client_secret:this.env.DISCORD_CLIENT_SECRET,grant_type:'authorization_code',code,redirect_uri:this.env.OAUTH_REDIRECT_URI}),signal:AbortSignal.timeout(10000)});
      if(!response.ok)return await rejected(response,'token');
      stage='token_response';token=await response.json();
      if(typeof token.access_token!=='string')return fail('디스코드 인증 실패 [token_response]. 인증 토큰 응답을 확인하지 못했습니다.');
      if(typeof token.scope!=='string'||!token.scope.split(/\s+/).includes('identify'))return fail('디스코드 인증 실패 [identify_scope]. 계정 식별 권한을 승인한 뒤 다시 시도하세요.');
      stage='identity_request';
      const identity=await fetch('https://discord.com/api/v10/users/@me',{headers:{...requestHeaders,Authorization:'Bearer '+token.access_token},signal:AbortSignal.timeout(10000)});if(!identity.ok)return await rejected(identity,'identity');
      stage='identity_response';
      const user=await identity.json();if(!/^\d{17,22}$/.test(user.id)||typeof user.username!=='string')return fail('디스코드 인증 실패 [identity_response]. 계정 정보 응답을 확인하지 못했습니다.');
      stage='link_prepare';
      return await this.ctx.blockConcurrencyWhile(async()=>{
      const current=await this.store.get('agent:'+pending.agent),flow=await this.store.get('oauth-flow:'+pending.agent);
      if(!current||current.session!==pending.session||flow?.state!==state||pending.until<=Date.now())return html('인증 요청이 변경되거나 만료되었습니다. 앱에서 다시 시작하세요.',409);
      const reason=await this.denied('link',user.id,current.version||'',current);if(reason)return fail(reason);
      const prior=await this.store.get('user:'+user.id);
      if((current.user&&current.user!==user.id)||(prior&&prior.agent!==pending.agent))return fail('이미 다른 연결이 있습니다. 기존 연결을 해제한 뒤 다시 시도하세요.');
      const nonce=crypto.randomUUID();await this.store.put('oauth-ready:'+pending.agent,{nonce,user:user.id,name:(user.global_name||user.username).slice(0,100),session:pending.session,until:Date.now()+60000});await this.schedule();
      await this.store.delete('oauth-flow:'+pending.agent);
      this.send(pending.agent,{type:'oauth-ready',nonce});return html('Erinn Desk에서 연결을 마무리하고 있습니다.\n앱에서 연결 상태를 확인해 주세요.');
      });
    }catch(error){const timeout=error?.name==='TimeoutError'||error?.name==='AbortError';return fail('디스코드 인증 실패 ['+stage+(timeout?' / timeout':'')+']. '+(timeout?'응답 시간이 초과되었습니다. ':'')+'앱에서 다시 시도하세요.');}
    finally{if(token?.access_token)try{await fetch('https://discord.com/api/v10/oauth2/token/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:this.env.DISCORD_APPLICATION_ID,client_secret:this.env.DISCORD_CLIENT_SECRET,token:token.access_token,token_type_hint:'access_token'}),signal:AbortSignal.timeout(5000)});}catch{}}
  }
  async oauthFinish(id,agent,ws,nonce){
    const ready=await this.store.get('oauth-ready:'+id);
    if(!ready||ready.until<=Date.now()||ready.session!==agent.session||nonce!==ready.nonce)return;
    await this.store.delete('oauth-ready:'+id);
    const reason=await this.denied('link',ready.user,agent.version||'',agent);if(reason){ws.send(JSON.stringify({type:'error',message:reason}));return;}
    const prior=await this.store.get('user:'+ready.user);
    if((prior&&prior.agent!==id)||(agent.user&&agent.user!==ready.user)){ws.send(JSON.stringify({type:'error',message:'기존 연결을 해제한 뒤 다시 시도하세요.'}));return;}
    await this.unlink(id);agent=await this.store.get('agent:'+id);
    agent.user=ready.user;agent.userName=ready.name;agent.linkVersion=crypto.randomUUID();agent.approvedAt=Date.now();delete agent.registrationUntil;
    await this.store.delete('unapproved:'+id);await this.store.put('agent:'+id,agent);await this.store.put('user:'+ready.user,{agent:id});
    ws.send(JSON.stringify({type:'linked',linked:{id:ready.user,name:ready.name}}));
  }
  async unlink(id) {
    const agent=await this.store.get('agent:'+id);if(!agent)return;
    if(agent.user&&(await this.store.get('user:'+agent.user))?.agent===id)await this.store.delete('user:'+agent.user);
    agent.linkVersion=crypto.randomUUID();
    delete agent.user;delete agent.userName;await this.store.put('agent:'+id,agent);
    await this.store.delete('pending:'+id);
    await this.store.delete('oauth-ready:'+id);
    await this.store.delete('oauth-flow:'+id);
    for(const [key,value]of await this.store.list({prefix:'oauth:'}))if(value.agent===id)await this.store.delete(key);
    const codes=await this.store.list({prefix:'code:'});
    for(const [key,code]of codes)if(code.agent===id)await this.store.delete(key);
    const queries=await this.store.list({prefix:'query:'});
    for(const [key,query]of queries)if(query.agent===id)await this.complete(key,query,'PC 연결이 해제되어 조회를 취소했습니다.');
    this.send(id,{type:'linked',linked:null});
  }
  async webSocketMessage(ws, message) {
    if(typeof message!=='string' || message.length>32768){ws.close(1009,'Too large');return;}
    let data;try{data=JSON.parse(message);}catch{ws.close(1008,'Invalid JSON');return;}
    const id=ws.deserializeAttachment()?.id;
    if(!id)return;
    await this.ctx.blockConcurrencyWhile(async()=>{
      const socketAgent=await this.store.get('agent:'+id);
      if(!socketAgent||socketAgent.session!==ws.deserializeAttachment()?.session){ws.close(1008,'Session replaced or registration removed');return;}
      if(await this.expireRegistration(id,socketAgent))return;
      if(data.type==='oauth-start'){await this.oauthStart(id,socketAgent,ws);return;}
      if(data.type==='oauth-finish'){await this.oauthFinish(id,socketAgent,ws,data.nonce);return;}
      if(data.type==='pair') {
        const reason=await this.denied('link',socketAgent.user,socketAgent.version||'',socketAgent);if(reason){ws.send(JSON.stringify({type:'error',message:reason}));return;}
        if(await this.limited('pair-rate:'+id,5,60000)){ws.send(JSON.stringify({type:'error',message:'연결 코드는 1분에 최대 5번 생성할 수 있습니다.'}));return;}
        await this.store.delete('pending:'+id);
        const codes=await this.store.list({prefix:'code:'});for(const [key,v]of codes)if(v.agent===id)await this.store.delete(key);
        const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let code;
        do{code=Array.from(crypto.getRandomValues(new Uint8Array(10)),n=>alphabet[n%alphabet.length]).join('');}while(await this.store.get('code:'+code));
        const until=Date.now()+600000;await this.store.put('code:'+code,{agent:id,until});await this.schedule();
        ws.send(JSON.stringify({type:'code',code,until}));return;
      }
      if(data.type==='approve' || data.type==='reject') {
        const pending=await this.store.get('pending:'+id);
        if(!pending || pending.until<=Date.now() || pending.nonce!==data.nonce){ws.send(JSON.stringify({type:'error',message:'승인 요청이 만료되었습니다. 연결 코드를 다시 생성하세요.'}));return;}
        await this.store.delete('pending:'+id);
        if(data.type==='reject'){ws.send(JSON.stringify({type:'approval_cleared'}));return;}
        const reason=await this.denied('link',pending.user,socketAgent.version||'',socketAgent);if(reason){ws.send(JSON.stringify({type:'approval_cleared'}));ws.send(JSON.stringify({type:'error',message:reason}));return;}
        const prior=await this.store.get('user:'+pending.user);
        if(prior?.agent && prior.agent!==id)await this.unlink(prior.agent);
        await this.unlink(id);
        const agent=await this.store.get('agent:'+id);
        agent.user=pending.user;agent.userName=pending.name;agent.linkVersion=crypto.randomUUID();
        agent.approvedAt=Date.now();delete agent.registrationUntil;await this.store.delete('unapproved:'+id);
        await this.store.put('agent:'+id,agent);await this.store.put('user:'+pending.user,{agent:id});
        ws.send(JSON.stringify({type:'linked',linked:{id:pending.user,name:pending.name}}));return;
      }
      if(data.type==='unlink'){await this.unlink(id);return;}
      if(data.type==='retire') {
        await this.unlink(id);await this.store.delete('agent:'+id);
        await this.store.delete('unapproved:'+id);ws.close(1000,'Retired');return;
      }
      if(data.type==='result' && typeof data.id==='string') {
        const key='query:'+data.id,pending=await this.store.get(key),agent=await this.store.get('agent:'+id);
        if(!pending || pending.agent!==id || !await this.authorized(pending))return;
        const captureErrors={capture_disabled:'PC의 에린 데스크에서 게임 화면 전송을 먼저 허용하세요.',capture_cooldown:'게임 화면 캡처는 PC당 10분에 한 번 사용할 수 있습니다.',capture_failed:'게임 창을 캡처하지 못했습니다. 최소화·잠금 상태 또는 검은 화면일 수 있습니다. PC에서 게임 창을 확인하세요.',busy:'PC에서 다른 원격 요청이 진행 중입니다.'};
        await this.complete(key,pending,pending.until<=Date.now()?'게임 조회 시간이 초과되었습니다. 다시 요청하세요.':data.result?.error==='policy_unavailable'?'PC에서 운영 정보 또는 공식 파일을 확인하지 못해 요청을 실행하지 않았습니다. PC의 Erinn Desk 안내를 확인하세요.':pending.kind==='capture'?(captureErrors[data.result?.error]||'게임 화면을 받지 못했습니다.'):formatItems(data.result),null,true);
      }
    });
  }
  async captureUpload(request) {
    const match=/^Bearer ([a-f0-9-]{36}):([a-f0-9-]{72})$/.exec(request.headers.get('Authorization')||'');
    const agent=match&&await this.store.get('agent:'+match[1]);
    if(!agent||await hash(match[2])!==agent.hash)return json({error:'unauthorized'},401);
    if(request.headers.get('Content-Type')!=='image/jpeg')return json({error:'invalid_image'},415);
    const length=Number(request.headers.get('Content-Length'));
    if(!Number.isInteger(length)||length<4||length>512000)return json({error:'too_large'},413);
    const id=new URL(request.url).pathname.split('/').pop(),key='query:'+id;
    const allowed=p=>p&&p.kind==='capture'&&p.agent===match[1]&&p.user===agent.user&&p.until>Date.now();
    if(!allowed(await this.store.get(key)))return json({error:'expired'},409);
    const chunks=[];let total=0;const reader=request.body.getReader();
    while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>512000){await reader.cancel();return json({error:'too_large'},413);}chunks.push(value);}
    const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    if(total!==length||bytes[0]!==255||bytes[1]!==216||bytes[total-2]!==255||bytes[total-1]!==217)return json({error:'invalid_image'},415);
    return this.ctx.blockConcurrencyWhile(async()=>{
      const pending=await this.store.get(key),current=await this.store.get('agent:'+match[1]);
      if(!allowed(pending)||!current||await hash(match[2])!==current.hash||!await this.authorized(pending))return json({error:'expired'},409);
      const delivered=await this.complete(key,pending,'게임 화면 · 요청자에게만 표시됩니다.',bytes);
      return delivered?json({ok:true}):json({error:'discord_delivery_failed'},502);
    });
  }
  async authorized(pending) {
    const records=await this.store.get(['agent:'+pending.agent,'user:'+pending.user]);
    const agent=records.get('agent:'+pending.agent),link=records.get('user:'+pending.user);
    if(await this.denied(pending.kind==='capture'?'capture':'items',pending.user,agent?.version||'',agent))return false;
    return agent?.user===pending.user&&link?.agent===pending.agent&&(agent.linkVersion??null)===(pending.linkVersion??null);
  }
  async complete(key,pending,content,image=null,sensitive=false) {
    // Remove the request first: reconnect/replayed results cannot send it twice.
    await this.store.delete(key);
    if((await this.store.get('busy:'+pending.agent))?.id===key.slice(6))await this.store.delete('busy:'+pending.agent);
    const token=pending.token;
    const delivery=(async()=>{
      for(let attempt=0;attempt<3;attempt++) {
        if((image||sensitive)&&!await this.authorized(pending))return false;
        try {
          const payload={content,allowed_mentions:{parse:[]}};let body=JSON.stringify(payload),headers={'Content-Type':'application/json'};
          if(image){payload.attachments=[{id:0,filename:'erinn-game.jpg'}];body=new FormData();body.append('payload_json',JSON.stringify(payload));body.append('files[0]',new Blob([image],{type:'image/jpeg'}),'erinn-game.jpg');headers={};}
          const r=await fetch(`https://discord.com/api/v10/webhooks/${pending.application}/${token}/messages/@original`,{method:'PATCH',headers,body});
          if(r.ok)return true;
          // A fast PC may finish before Discord has persisted the initial defer.
          if(![404,429,500,502,503,504].includes(r.status)){console.error('Discord response failed',r.status);return false;}
        } catch { /* PATCH is idempotent; retry network failures without requerying the game. */ }
        if(attempt<2)await new Promise(resolve=>setTimeout(resolve,750*(attempt+1)));
      }
      console.error('Discord response retry exhausted');return false;
    })();
    if(image){const delivered=await delivery;if(delivered){await this.store.put('capture-success:'+pending.agent,{until:Date.now()+600000});await this.schedule();}return delivered;}
    this.ctx.waitUntil(delivery);return false;
  }
  async schedule() {const next=Date.now()+60000,current=await this.store.getAlarm();if(!current || current>next)await this.store.setAlarm(next);}
  async expireRegistration(id,agent) {
    if(!agent || agent.user || agent.approvedAt || !Number.isFinite(agent.registrationUntil) || agent.registrationUntil>Date.now())return false;
    await this.unlink(id);
    await this.store.delete('agent:'+id);await this.store.delete('unapproved:'+id);
    await this.store.delete('pair-rate:'+id);
    for(const ws of this.sockets(id)){try{ws.send(JSON.stringify({type:'registration_expired'}));ws.close(4001,'Registration expired');}catch{}}
    return true;
  }
  async alarm() {
    return this.ctx.blockConcurrencyWhile(async()=>this.expire());
  }
  async expire() {
    const queries=await this.store.list({prefix:'query:'});for(const [key,value]of queries)if(value.until<=Date.now())await this.complete(key,value,'PC에서 제한 시간 내에 조회 결과를 받지 못했습니다. 연결을 확인하고 다시 요청하세요.');
    let keep=false;
    for(const [key,value] of await this.store.list({prefix:'unapproved:'})){
      const id=key.slice(11),agent=await this.store.get('agent:'+id);
      if(!agent || agent.user || agent.approvedAt){await this.store.delete(key);continue;}
      if(value.until<=Date.now())await this.expireRegistration(id,agent);else keep=true;
    }
    const globalRate=await this.store.get('registration-global');if(globalRate?.until<=Date.now())await this.store.delete('registration-global');else if(globalRate)keep=true;
    for(const prefix of ['oauth:','oauth-flow:','oauth-ready:','query:','code:','pending:','interaction:','rate:','reg:','pair-rate:','capture-rate:','capture-success:','busy:']) {
      const rows=await this.store.list({prefix});for(const [key,value]of rows){if(value.until<=Date.now())await this.store.delete(key);else keep=true;}
    }
    if(keep)await this.schedule();
  }
}


export function oauthResultPage(message,status=200,kind=''){
  const success=status<400,cancelled=kind==='cancel';
  const title=success?'디스코드 인증 완료':cancelled?'인증을 취소했습니다':'디스코드 인증 확인 필요';
  const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const paragraphs=String(message).split('\n').map(line=>'<p>'+escape(line)+'</p>').join('');
  const body=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${title} · Erinn Desk</title><style>
:root{color-scheme:dark;font-family:'Segoe UI','Malgun Gothic',sans-serif;background:#151618;color:#e4cfa8}*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100svh;display:grid;place-items:center;padding:32px 20px}main{width:100%;max-width:510px}header{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:28px}.logo{position:relative;width:43px;height:46px;border-radius:13px;background:#dec183;color:#352a17;font:42px/43px Georgia,serif;text-align:center}.logo:after{content:'✦';position:absolute;right:3px;top:0;font:13px/16px Georgia,serif;color:#fff9e9}.brand{font:32px/1 Georgia,serif;letter-spacing:-1px}.brand small{display:block;font:9px/1.4 'Segoe UI',sans-serif;letter-spacing:5px;margin-top:7px;padding-left:2px}article{background:#202225;border:1px solid #3e4145;border-radius:20px;padding:38px 28px 28px;text-align:center}.status-icon{display:grid;place-items:center;width:52px;height:52px;margin:0 auto 22px;border-radius:50%;font-size:26px;background:#dec1831a;color:#dec183}.failure .status-icon{background:#f0a39b12;color:#f0a39b}.cancel .status-icon{background:#dec1831a;color:#dec183}h1{font-size:23px;line-height:1.5;margin:0 0 18px;font-weight:600;letter-spacing:-.6px}.message{font-size:14px;line-height:1.9;color:#bcaa8e;overflow-wrap:anywhere}.message p{margin:0}.note{border-top:1px solid #3e4145;margin:28px 0 0;padding-top:21px;color:#bcaa8e;font-size:12px;line-height:1.8}footer{text-align:center;margin-top:20px;font-size:11px;color:#918574}@media(max-width:420px){article{padding:30px 20px 24px}h1{font-size:21px}}
</style></head><body><main><header aria-label="Erinn Desk"><span class="logo" aria-hidden="true">e</span><div class="brand">erinn<small>DESK</small></div></header><article class="${success?'success':cancelled?'cancel':'failure'}"><div class="status-icon" aria-hidden="true">${success?'✓':cancelled?'−':'!'}</div><h1>${title}</h1><div class="message">${paragraphs}</div><p class="note">이 탭은 닫아도 됩니다.</p></article><footer>Erinn Desk · 디스코드 연결</footer></main></body></html>`;
  return new Response(body,{status,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"}});
}
