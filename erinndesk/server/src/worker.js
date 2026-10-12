import { DurableObject } from 'cloudflare:workers';
import { json, reply, hash, verifyDiscord, validateName, formatItems } from './protocol.js';

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return json({ok:true,service:'Erinn Desk Remote',version:1,commit:env.DEPLOY_COMMIT || 'local'});
    const hub = env.HUB.get(env.HUB.idFromName('pilot-v1'));
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
    if (path === '/register' && request.method === 'POST') {
      const ip=request.headers.get('CF-Connecting-IP');
      if (!ip && !env.LOCAL_TEST) return json({error:'missing_ip'},403);
      return hub.fetch(new Request('https://hub/register',{method:'POST',headers:{'X-Client-Hash':await hash(ip || 'local')}}));
    }
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
  async fetch(request) {
    const path=new URL(request.url).pathname;
    if(/^\/capture\/\d{1,25}$/.test(path)&&request.method==='POST')return this.captureUpload(request);
    if(path==='/register')return this.ctx.blockConcurrencyWhile(async()=>{
      if(await this.limited('registration-global',30,60000))return json({error:'registration_rate_limited'},429);
      if(await this.limited('reg:'+request.headers.get('X-Client-Hash'),5,3600000))return json({error:'registration_rate_limited'},429);
      const id=crypto.randomUUID(),secret=crypto.randomUUID()+crypto.randomUUID();
      const now=Date.now(),until=now+30*60000;
      await this.store.put('agent:'+id,{hash:await hash(secret),created:now,registrationUntil:until});
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
    if(command==='테스트') {
      const commit=/^[a-f0-9]{40}$/i.test(this.env.DEPLOY_COMMIT || '')?this.env.DEPLOY_COMMIT.slice(0,12):'수동 배포';
      return finish(reply(`에린데스크 서버가 정상 응답했습니다.\n배포 버전: ${commit}\nPC 연결 없이 서버 응답만 확인했습니다.`));
    }
    if(command==='연결') {
      if(typeof options['코드']!=='string' || !/^[A-Z2-9]{10}$/.test(options['코드'].toUpperCase()))return finish(reply('PC의 에린 데스크에서 새 연결 코드를 생성해 입력하세요.'));
      const key='code:'+options['코드'].toUpperCase(),code=await this.store.get(key);
      if(!code || code.until<Date.now())return finish(reply('연결 코드가 만료되었거나 올바르지 않습니다. PC에서 다시 생성하세요.'));
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
  async unlink(id) {
    const agent=await this.store.get('agent:'+id);if(!agent)return;
    if(agent.user&&(await this.store.get('user:'+agent.user))?.agent===id)await this.store.delete('user:'+agent.user);
    agent.linkVersion=crypto.randomUUID();
    delete agent.user;delete agent.userName;await this.store.put('agent:'+id,agent);
    await this.store.delete('pending:'+id);
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
      if(data.type==='pair') {
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
        await this.complete(key,pending,pending.until<=Date.now()?'게임 조회 시간이 초과되었습니다. 다시 요청하세요.':pending.kind==='capture'?(captureErrors[data.result?.error]||'게임 화면을 받지 못했습니다.'):formatItems(data.result),null,true);
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
    for(const prefix of ['query:','code:','pending:','interaction:','rate:','reg:','pair-rate:','capture-rate:','capture-success:','busy:']) {
      const rows=await this.store.list({prefix});for(const [key,value]of rows){if(value.until<=Date.now())await this.store.delete(key);else keep=true;}
    }
    if(keep)await this.schedule();
  }
}
