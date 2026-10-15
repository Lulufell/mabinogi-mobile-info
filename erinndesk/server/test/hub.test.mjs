import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { hash } from '../src/protocol.js';

// Execute the actual Worker implementation with only the Cloudflare host object replaced.
const code=(await fs.readFile(new URL('../src/worker.js',import.meta.url),'utf8'))
 .replace("import { DurableObject } from 'cloudflare:workers';",'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}')
 .replace("'./operations.js'",JSON.stringify(new URL('../src/operations.js',import.meta.url).href))
 .replace("'./protocol.js'",JSON.stringify(new URL('../src/protocol.js',import.meta.url).href));
const {RemoteHub,default:Worker}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
class Storage{
 values=new Map();alarm=null;
 async get(k){return Array.isArray(k)?new Map(k.filter(key=>this.values.has(key)).map(key=>[key,structuredClone(this.values.get(key))])):structuredClone(this.values.get(k));}
 async put(k,v){this.values.set(k,structuredClone(v));}
 async delete(k){this.values.delete(k);}
 async list({prefix=''}={}){return new Map([...this.values].filter(([k])=>k.startsWith(prefix)));}
 async transaction(fn){return fn(this);}
 async deleteAlarm(){this.alarm=null;}
 async getAlarm(){return this.alarm;}
 async setAlarm(v){this.alarm=v;}
}
class Socket{
 constructor(id){this.id=id;this.messages=[];}
 send(m){this.messages.push(JSON.parse(m));}
 deserializeAttachment(){return {id:this.id,...(this.session?{session:this.session}:{})};}
 close(){}
}
function setup(serialized=false){
 const storage=new Storage(),socket=new Socket('pc-a'),other=new Socket('pc-b'),tasks=[];
 let gate=Promise.resolve();
 const ctx={storage,getWebSockets:id=>[socket,other].filter(s=>s.id===id),blockConcurrencyWhile:fn=>{if(!serialized)return fn();const task=gate.then(fn);gate=task.catch(()=>{});return task;},waitUntil:task=>tasks.push(task)};
 const hub=new RemoteHub(ctx,{MAX_DEVICES:'2'});return {hub,storage,socket,other,tasks};
}

test('capture is owner-only, ten-minute cooldown, bounded, authenticated and single-use',async()=>{
 const {hub,storage,socket,tasks}=setup();const agent=crypto.randomUUID(),secret=crypto.randomUUID()+crypto.randomUUID();socket.id=agent;
 await storage.put('agent:'+agent,{user:'user-a',hash:await hash(secret)});await storage.put('user:user-a',{agent});
 const wrong=await hub.discord(command('스크린샷',[],'user-b'));assert.equal((await wrong.json()).type,4);
 const request=command('스크린샷');assert.equal((await (await hub.discord(request)).json()).type,5);assert.equal(socket.messages.at(-1).type,'capture');
 const image=new Uint8Array([255,216,1,2,255,217]);
 const upload=(token=secret,type='image/jpeg',length=image.length)=>new Request('https://hub/capture/'+request.id,{method:'POST',headers:{'Authorization':'Bearer '+agent+':'+token,'Content-Type':type,'Content-Length':String(length)},body:image});
 assert.equal((await hub.fetch(upload('0'.repeat(72)))).status,401);
 assert.equal((await hub.fetch(upload(secret,'image/png'))).status,415);
 assert.equal((await hub.fetch(upload(secret,'image/jpeg',512001))).status,413);
 const sent=[],originalFetch=globalThis.fetch;globalThis.fetch=async(url,init)=>{sent.push(init.body);return new Response('{}');};
 try{
  const before=Date.now();
  assert.equal((await hub.fetch(upload())).status,200);await Promise.all(tasks);assert.equal(sent.length,1);assert(sent[0] instanceof FormData);
  const cooldown=await storage.get('capture-success:'+agent);
  assert(cooldown.until>=before+600000 && cooldown.until<=Date.now()+600000);
  assert.equal(sent[0].get('files[0]').type,'image/jpeg');assert.equal(JSON.parse(sent[0].get('payload_json')).attachments[0].filename,'erinn-game.jpg');
  assert.equal((await hub.fetch(upload())).status,409);
  const next=await hub.discord(command('스크린샷'));assert((await next.json()).data.content.includes('10분'));
 }finally{globalThis.fetch=originalFetch;}
});

test('capture failures and timeouts allow retry; legacy cooldown is ignored',async()=>{
 const {hub,storage,socket,tasks}=setup();const agent=crypto.randomUUID(),secret=crypto.randomUUID()+crypto.randomUUID();socket.id=agent;
 await storage.put('agent:'+agent,{user:'user-a',hash:await hash(secret)});await storage.put('user:user-a',{agent});
 await storage.put('capture-rate:'+agent,{count:1,until:Date.now()+3600000});
 const oldFetch=globalThis.fetch;globalThis.fetch=async()=>new Response('{}');
 try{
  const first=command('스크린샷');assert.equal((await (await hub.discord(first)).json()).type,5);
  await hub.webSocketMessage(socket,JSON.stringify({type:'result',id:first.id,result:{ok:false,error:'capture_failed'}}));
  assert.equal(await storage.get('capture-success:'+agent),undefined);
  const second=command('스크린샷');assert.equal((await (await hub.discord(second)).json()).type,5);
  const pending=await storage.get('query:'+second.id);pending.until=Date.now()-1;await storage.put('query:'+second.id,pending);await hub.alarm();
  assert.equal((await (await hub.discord(command('스크린샷'))).json()).type,5);
  await Promise.all(tasks);
 }finally{globalThis.fetch=oldFetch;}
});

test('Discord upload rejection does not spend capture cooldown',async()=>{
 const {hub,storage,socket}=setup();const agent=crypto.randomUUID(),secret=crypto.randomUUID()+crypto.randomUUID();socket.id=agent;
 await storage.put('agent:'+agent,{user:'user-a',hash:await hash(secret)});await storage.put('user:user-a',{agent});
 const query=command('스크린샷');await hub.discord(query);
 const oldFetch=globalThis.fetch;globalThis.fetch=async()=>new Response('{}',{status:403});
 try{
  const response=await hub.fetch(new Request('https://hub/capture/'+query.id,{method:'POST',headers:{'Authorization':'Bearer '+agent+':'+secret,'Content-Type':'image/jpeg','Content-Length':'4'},body:new Uint8Array([255,216,255,217])}));
  assert.equal(response.status,502);assert.equal(await storage.get('capture-success:'+agent),undefined);
  assert.equal((await (await hub.discord(command('스크린샷'))).json()).type,5);
 }finally{globalThis.fetch=oldFetch;}
});

test('unlink prevents an already requested screenshot from uploading',async()=>{
 const {hub,storage,socket,tasks}=setup();const agent=crypto.randomUUID(),secret=crypto.randomUUID()+crypto.randomUUID();socket.id=agent;
 await storage.put('agent:'+agent,{user:'user-a',hash:await hash(secret)});await storage.put('user:user-a',{agent});
 const query=command('스크린샷');await hub.discord(query);
 const originalFetch=globalThis.fetch;globalThis.fetch=async()=>new Response('{}');
 try{await hub.unlink(agent);await Promise.all(tasks);}finally{globalThis.fetch=originalFetch;}
 const r=await hub.fetch(new Request('https://hub/capture/'+query.id,{method:'POST',headers:{'Authorization':'Bearer '+agent+':'+secret,'Content-Type':'image/jpeg','Content-Length':'4'},body:new Uint8Array([255,216,255,217])}));assert.equal(r.status,409);
});
let id=1000;
const command=(name,options=[],user='user-a')=>({type:2,id:String(++id),application_id:'app',token:'test-token',member:{user:{id:user,username:user}},data:{name,options}});

test('signed requests still require the configured application and guild; forged requests never dispatch',async()=>{
 const keys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
 const publicKey=Buffer.from(await crypto.subtle.exportKey('raw',keys.publicKey)).toString('hex');let calls=0;
 const env={DISCORD_APPLICATION_ID:'app',DISCORD_GUILD_ID:'guild',DISCORD_PUBLIC_KEY:publicKey,HUB:{idFromName:()=>'',get:()=>({fetch:async()=>{calls++;return new Response('{}');}})}};
 async function send(data,tamper=false){const body=JSON.stringify(data),timestamp=String(Math.floor(Date.now()/1000));const signature=Buffer.from(await crypto.subtle.sign('Ed25519',keys.privateKey,new TextEncoder().encode(timestamp+body))).toString('hex');return Worker.fetch(new Request('https://service/discord',{method:'POST',body:tamper?body+' ':body,headers:{'X-Signature-Timestamp':timestamp,'X-Signature-Ed25519':signature}}),env);}
 const valid={...command('연결상태'),guild_id:'guild'};
 assert.equal((await send(valid,true)).status,401);assert.equal(calls,0);
 assert.equal((await (await send({...valid,application_id:'other'})).json()).type,4);
 assert.equal((await (await send({...valid,guild_id:'other'})).json()).type,4);assert.equal(calls,0);
 await send(valid);assert.equal(calls,1);
});

test('unapproved PCs, expired codes/approvals and approvals from another PC cannot link',async()=>{
 const {hub,storage,socket,other}=setup();await storage.put('agent:pc-a',{});await storage.put('agent:pc-b',{});
 const unapproved=await hub.discord(command('아이템',[{name:'이름',value:'가죽'}]));assert.equal((await unapproved.json()).type,4);assert.equal(socket.messages.length,0);
 await storage.put('code:ABCDEFGHJK',{agent:'pc-a',until:Date.now()-1});await hub.discord(command('연결',[{name:'코드',value:'ABCDEFGHJK'}]));assert.equal(await storage.get('pending:pc-a'),undefined);
 await storage.put('pending:pc-a',{nonce:'nonce',user:'user-a',name:'A',until:Date.now()+10000});
 await hub.webSocketMessage(other,JSON.stringify({type:'approve',nonce:'nonce'}));assert.equal(await storage.get('user:user-a'),undefined);
 await storage.put('pending:pc-a',{nonce:'nonce',user:'user-a',name:'A',until:Date.now()-1});
 await hub.webSocketMessage(socket,JSON.stringify({type:'approve',nonce:'nonce'}));assert.equal(await storage.get('user:user-a'),undefined);
});

test('second PC approval replaces first only after approval, cancels old requests and rejects old results',async()=>{
 const {hub,storage,socket,other,tasks}=setup();await storage.put('agent:pc-a',{user:'user-a',linkVersion:'old'});await storage.put('user:user-a',{agent:'pc-a'});await storage.put('agent:pc-b',{});
 await storage.put('pending:pc-b',{nonce:'nonce',user:'user-a',name:'A',until:Date.now()+10000});
 assert.equal((await storage.get('user:user-a')).agent,'pc-a');
 const query=command('아이템',[{name:'이름',value:'가죽'}]);await hub.discord(query);
 const sent=[],oldFetch=globalThis.fetch;globalThis.fetch=async(url,init)=>{sent.push(JSON.parse(init.body).content);return new Response('{}');};
 try{
  await hub.webSocketMessage(other,JSON.stringify({type:'approve',nonce:'nonce'}));await Promise.all(tasks);
  assert.equal((await storage.get('user:user-a')).agent,'pc-b');assert.equal((await storage.get('agent:pc-a')).user,undefined);
  assert.equal(await storage.get('query:'+query.id),undefined);
  await hub.webSocketMessage(socket,JSON.stringify({type:'result',id:query.id,result:{ok:true,items:[{name:'private-item',locations:{inventory:999}}]}}));
  assert(sent.every(s=>!s.includes('private-item')));
  await hub.discord(command('아이템',[{name:'이름',value:'가죽'}]));assert.equal(other.messages.at(-1).type,'query');
 }finally{globalThis.fetch=oldFetch;}
});

test('replaced websocket cannot approve, unlink, retire or submit results',async()=>{
 const {hub,storage,socket}=setup();await storage.put('agent:pc-a',{user:'user-a',session:'new'});await storage.put('user:user-a',{agent:'pc-a'});socket.session='old';
 await storage.put('pending:pc-a',{nonce:'n',user:'user-b',name:'B',until:Date.now()+10000});
 for(const message of [{type:'approve',nonce:'n'},{type:'unlink'},{type:'retire'},{type:'pair'},{type:'result',id:'12345',result:{ok:true,items:[]}}])await hub.webSocketMessage(socket,JSON.stringify(message));
 assert.equal((await storage.get('agent:pc-a')).user,'user-a');assert.equal((await storage.get('user:user-a')).agent,'pc-a');assert.equal(await storage.get('user:user-b'),undefined);
});

test('a stale reverse mapping never authorizes a query or unlink of another owner',async()=>{
 const {hub,storage,socket}=setup();await storage.put('agent:pc-a',{user:'user-b'});await storage.put('user:user-a',{agent:'pc-a'});
 for(const name of ['アイテム','아이템','스크린샷','연결해제'])assert.equal((await (await hub.discord(command(name,[{name:'이름',value:'가죽'}]))).json()).type,4);
 assert.equal((await storage.get('agent:pc-a')).user,'user-b');assert.equal(socket.messages.length,0);
});

test('revoking and reapproving the same owner prevents sensitive response retries',async()=>{
 const {hub,storage,socket,tasks}=setup();await storage.put('agent:pc-a',{user:'user-a',linkVersion:'old'});await storage.put('user:user-a',{agent:'pc-a'});
 const query=command('아이템',[{name:'이름',value:'가죽'}]);await hub.discord(query);let sends=0;const oldFetch=globalThis.fetch;
 globalThis.fetch=async()=>{sends++;await hub.unlink('pc-a');await storage.put('agent:pc-a',{user:'user-a',linkVersion:'new'});await storage.put('user:user-a',{agent:'pc-a'});return new Response('{}',{status:500});};
 try{await hub.webSocketMessage(socket,JSON.stringify({type:'result',id:query.id,result:{ok:true,items:[{name:'private-item',locations:{inventory:1}}]}}));await Promise.all(tasks);assert.equal(sends,1);}finally{globalThis.fetch=oldFetch;}
});

test('another PC with valid credentials cannot upload into the owners capture request',async()=>{
 const {hub,storage,socket,other}=setup();const a=crypto.randomUUID(),b=crypto.randomUUID(),sa=crypto.randomUUID()+crypto.randomUUID(),sb=crypto.randomUUID()+crypto.randomUUID();socket.id=a;other.id=b;
 await storage.put('agent:'+a,{user:'user-a',hash:await hash(sa)});await storage.put('user:user-a',{agent:a});await storage.put('agent:'+b,{user:'user-b',hash:await hash(sb)});await storage.put('user:user-b',{agent:b});
 const query=command('스크린샷');await hub.discord(query);
 const response=await hub.fetch(new Request('https://hub/capture/'+query.id,{method:'POST',headers:{'Authorization':'Bearer '+b+':'+sb,'Content-Type':'image/jpeg','Content-Length':'4'},body:new Uint8Array([255,216,255,217])}));
 assert.equal(response.status,409);assert.notEqual(await storage.get('query:'+query.id),undefined);
});

test('concurrent approval and request serialize without dispatching to the previous PC',async()=>{
 for(const approvalFirst of [false,true]){
  const {hub,storage,socket,other,tasks}=setup(true);
  await storage.put('agent:pc-a',{user:'user-a'});await storage.put('agent:pc-b',{});await storage.put('user:user-a',{agent:'pc-a'});
  await storage.put('pending:pc-b',{nonce:'n',user:'user-a',name:'A',until:Date.now()+10000});
  const oldFetch=globalThis.fetch;globalThis.fetch=async()=>new Response('{}');
  try{
   const query=command('아이템',[{name:'이름',value:'가죽'}]);
   const approve=()=>hub.webSocketMessage(other,JSON.stringify({type:'approve',nonce:'n'}));
   const request=()=>hub.fetch(new Request('https://hub/discord',{method:'POST',body:JSON.stringify(query)}));
   await Promise.all(approvalFirst?[approve(),request()]:[request(),approve()]);await Promise.all(tasks);
   assert.equal((await storage.get('user:user-a')).agent,'pc-b');
   if(approvalFirst){assert.equal(socket.messages.filter(m=>m.type==='query').length,0);assert.equal(other.messages.at(-1).type,'query');}
   else assert.equal(await storage.get('query:'+query.id),undefined);
  }finally{globalThis.fetch=oldFetch;}
 }
});

test('capture body arriving after reapproval or credential revocation is rejected',async()=>{
 for(const revokeCredential of [false,true]){
  const {hub,storage,socket}=setup();const agent=crypto.randomUUID(),secret=crypto.randomUUID()+crypto.randomUUID();socket.id=agent;
  await storage.put('agent:'+agent,{user:'user-a',hash:await hash(secret),linkVersion:'old'});await storage.put('user:user-a',{agent});
  const query=command('스크린샷');await hub.discord(query);
  // Supply a slow request body. The ownership/credential changes before its last bytes arrive.
  const request={url:'https://hub/capture/'+query.id,headers:new Headers({'Authorization':'Bearer '+agent+':'+secret,'Content-Type':'image/jpeg','Content-Length':'4'}),body:{getReader:()=>{let first=true;return {read:async()=>{if(!first)return {done:true};first=false;const current=await storage.get('agent:'+agent);if(revokeCredential)current.hash=await hash('revoked');else current.linkVersion='new';await storage.put('agent:'+agent,current);return {done:false,value:new Uint8Array([255,216,255,217])};}};}}};
  const oldFetch=globalThis.fetch;let sent=0;globalThis.fetch=async()=>{sent++;return new Response('{}');};
  try{assert.equal((await hub.captureUpload(request)).status,409);assert.equal(sent,0);}finally{globalThis.fetch=oldFetch;}
 }
});
test('pair must be locally approved; wrong user cannot query; same-name requests are read only',async()=>{
 const {hub,storage,socket}=setup();await storage.put('agent:pc-a',{hash:await hash('secret')});
 await hub.webSocketMessage(socket,JSON.stringify({type:'pair'}));
 const code=socket.messages.find(m=>m.type==='code').code;
 const result=await hub.discord(command('연결',[{name:'코드',value:code}]));assert.equal((await result.json()).data.flags,64);
 assert.equal(await storage.get('user:user-a'),undefined);
 const pending=await storage.get('pending:pc-a');
 await hub.webSocketMessage(socket,JSON.stringify({type:'approve',nonce:'wrong'}));assert.equal(await storage.get('user:user-a'),undefined);
 await hub.webSocketMessage(socket,JSON.stringify({type:'approve',nonce:pending.nonce}));
 assert.equal((await storage.get('user:user-a')).agent,'pc-a');
 const wrong=await hub.discord(command('아이템',[{name:'이름',value:'가죽'}],'user-b'));assert((await wrong.json()).data.content.includes('연결된 PC가 없습니다'));
 const query=command('아이템',[{name:'이름',value:'가죽'}]);
 assert.equal((await (await hub.discord(query)).json()).type,5);
 assert.equal(socket.messages.filter(m=>m.type==='query').length,1);
 await hub.discord(query);assert.equal(socket.messages.filter(m=>m.type==='query').length,1);
});
test('unlink clears in-flight queries, spoofed result ignored, legitimate result replies once',async()=>{
 const {hub,storage,socket,other,tasks}=setup();await storage.put('agent:pc-a',{user:'user-a'});await storage.put('user:user-a',{agent:'pc-a'});
 const sent=[],originalFetch=globalThis.fetch;globalThis.fetch=async(url,init)=>{sent.push({url,body:JSON.parse(init.body)});return new Response('{}');};
 try{
  const query=command('아이템',[{name:'이름',value:'가죽'}]);await hub.discord(query);
  const data={type:'result',id:query.id,result:{ok:true,items:[{name:'가죽',locations:{inventory:7}}]}};
  await hub.webSocketMessage(other,JSON.stringify(data));assert.equal(sent.length,0);
  await hub.webSocketMessage(socket,JSON.stringify(data));await Promise.all(tasks);assert.equal(sent.length,1);assert(sent[0].body.content.includes('7개'));
  await hub.webSocketMessage(socket,JSON.stringify(data));assert.equal(sent.length,1);
  const second=command('아이템',[{name:'이름',value:'가죽'}]);await hub.discord(second);await hub.unlink('pc-a');await Promise.all(tasks);
  assert.equal(await storage.get('query:'+second.id),undefined);assert.equal(await storage.get('user:user-a'),undefined);
 }finally{globalThis.fetch=originalFetch;}
});
test('expired query gets timeout and legacy device count no longer limits registration',async()=>{
 const {hub,storage,tasks}=setup();await storage.put('device-count',2);
 assert.equal((await hub.fetch(new Request('https://hub/register',{method:'POST',headers:{'X-Client-Hash':'ip'}}))).status,200);
 const originalFetch=globalThis.fetch,sent=[];globalThis.fetch=async(url,init)=>{sent.push(JSON.parse(init.body));return new Response('{}');};
 try{
  await storage.put('query:expired',{agent:'pc-a',application:'app',token:'test',until:Date.now()-1});await hub.alarm();await Promise.all(tasks);
  assert.equal(sent.length,1);assert(sent[0].content.includes('제한 시간'));assert.equal(await storage.get('query:expired'),undefined);
 }finally{globalThis.fetch=originalFetch;}
});

test('unapproved registrations expire; approved and legacy PCs survive',async()=>{
 const {hub,storage}=setup();
 const response=await hub.fetch(new Request('https://hub/register',{method:'POST',headers:{'X-Client-Hash':'ip'}}));const reg=await response.json();
 const a=await storage.get('agent:'+reg.id);assert(a.registrationUntil>Date.now());
 a.registrationUntil=Date.now()-1;await storage.put('agent:'+reg.id,a);await storage.put('unapproved:'+reg.id,{until:a.registrationUntil});
 await storage.put('code:OLD',{agent:reg.id,until:Date.now()+10000});await storage.put('pending:'+reg.id,{until:Date.now()+10000});
 await storage.put('agent:approved',{approvedAt:1,registrationUntil:1});await storage.put('unapproved:approved',{until:1});
 await storage.put('agent:legacy',{hash:'preserved'});
 await hub.alarm();
 assert.equal(await storage.get('agent:'+reg.id),undefined);assert.equal(await storage.get('code:OLD'),undefined);assert.equal(await storage.get('pending:'+reg.id),undefined);
 assert(await storage.get('agent:approved'));assert(await storage.get('agent:legacy'));assert.equal(await storage.get('unapproved:approved'),undefined);
});
test('registration throttles frequency rather than stored PC count',async()=>{
 const {hub,storage}=setup();await storage.put('device-count',999999);
 for(let i=0;i<5;i++)assert.equal((await hub.fetch(new Request('https://hub/register',{method:'POST',headers:{'X-Client-Hash':'same'}}))).status,200);
 assert.equal((await hub.fetch(new Request('https://hub/register',{method:'POST',headers:{'X-Client-Hash':'same'}}))).status,429);
 for(let i=0;i<24;i++)assert.equal((await hub.fetch(new Request('https://hub/register',{method:'POST',headers:{'X-Client-Hash':'other'+i}}))).status,200);
 assert.equal((await hub.fetch(new Request('https://hub/register',{method:'POST',headers:{'X-Client-Hash':'last'}}))).status,429);
});

test('approval removes temporary expiry and unlink preserves approved registration',async()=>{
 const {hub,storage,socket}=setup();
 await storage.put('agent:pc-a',{hash:'x',registrationUntil:Date.now()+60000});await storage.put('unapproved:pc-a',{until:Date.now()+60000});
 await storage.put('pending:pc-a',{nonce:'approval',user:'u',name:'User',until:Date.now()+60000});
 await hub.webSocketMessage(socket,JSON.stringify({type:'approve',nonce:'approval'}));
 const agent=await storage.get('agent:pc-a');assert.equal(agent.user,'u');assert(agent.approvedAt);assert.equal(agent.registrationUntil,undefined);assert.equal(await storage.get('unapproved:pc-a'),undefined);
 await hub.unlink('pc-a');await hub.alarm();assert(await storage.get('agent:pc-a'));assert.equal(await storage.get('user:u'),undefined);
});
test('expired registration cannot approve or recreate pairing code before cleanup alarm',async()=>{
 const {hub,storage,socket}=setup();
 await storage.put('agent:pc-a',{registrationUntil:Date.now()-1});await storage.put('unapproved:pc-a',{until:Date.now()-1});
 await storage.put('pending:pc-a',{nonce:'approval',user:'u',name:'User',until:Date.now()+60000});
 await hub.webSocketMessage(socket,JSON.stringify({type:'approve',nonce:'approval'}));
 assert.equal(await storage.get('agent:pc-a'),undefined);assert.equal(await storage.get('user:u'),undefined);
 assert(socket.messages.some(m=>m.type==='registration_expired'));
});

test('maintenance reset path is not publicly routed',async()=>{
 const response=await Worker.fetch(new Request('https://public/maintenance-reset',{method:'POST'}),{HUB:{idFromName:()=>1,get:()=>({fetch:()=>{throw Error('must not forward');}})}});
 assert.equal(response.status,404);
});


test('health never accesses registration storage even with a stale reset variable',async()=>{
 const response=await Worker.fetch(new Request('https://public/health'),{REGISTRATION_RESET_EPOCH:'stale',DEPLOY_COMMIT:'abc',HUB:{get:()=>{throw Error('must not touch registrations');}}});
 assert.deepEqual(await response.json(),{ok:true,service:'Erinn Desk Remote',version:1,commit:'abc'});
});

test('removed commands never dispatch to a PC',async()=>{
 const {hub,storage,socket,other}=setup();
 await storage.put('user:user-a',{agent:socket.id});await storage.put('agent:'+socket.id,{user:'user-a'});
 const result=await (await hub.discord(command('테스트'))).json();
 assert(result.data.content.includes('지원하지 않는 명령'));assert.equal(result.data.flags,64);
 assert.equal(socket.messages.length,0);assert.equal(other.messages.length,0);
 assert.equal((await storage.list({prefix:'query:'})).size,0);
});

// Operations policy security: exercise real routing, signatures and existing links.
async function operationsFixture(){
 const f=setup(),keys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
 f.hub.env.OPS_PUBLIC_KEY=Buffer.from(await crypto.subtle.exportKey('raw',keys.publicKey)).toString('hex');
 f.policy={schema:1,revision:1,issuedAt:Date.now(),expiresAt:Date.now()+86400000,latest:'1.4.9',minimum:'1.4.9',scope:'discord',blocked:[],message:'새 버전을 설치하세요.',features:Object.fromEntries(['discord','link','items','capture'].map(k=>[k,{enabled:true,reason:''}])),releases:{'1.4.9':{sha256:'a'.repeat(64),size:123,url:'https://example.com/ErinnDesk.exe'}}};
 f.access={mode:'all',users:[]};
 const actualComplete=f.hub.complete.bind(f.hub);f.notices=[];f.hub.complete=async(key,pending,content,image=null,sensitive=false)=>{if(!image&&!sensitive){f.notices.push(content);await f.storage.delete(key);await f.storage.delete('busy:'+pending.agent);return false;}return actualComplete(key,pending,content,image,sensitive);};
 f.envelope=async p=>{const payload=JSON.stringify(p);return {payload,signature:Buffer.from(await crypto.subtle.sign('Ed25519',keys.privateKey,new TextEncoder().encode(payload))).toString('base64')};};
 f.publish=async(p=f.policy,a=f.access,expectedRevision=p.revision-1)=>f.hub.fetch(new Request('https://hub/admin/state',{method:'PUT',body:JSON.stringify({expectedRevision,envelope:await f.envelope(p),access:a})}));
 return f;
}

test('operations admin routes require a separate credential and never forward failed authentication',async()=>{
 let calls=0;const env={OPS_ADMIN_TOKEN:'x'.repeat(48),HUB:{idFromName:()=>'',get:()=>({fetch:async()=>{calls++;return new Response('{}');}})}};
 assert.equal((await Worker.fetch(new Request('https://service/admin/state'),env)).status,401);assert.equal(calls,0);
 assert.equal((await Worker.fetch(new Request('https://service/admin/state',{headers:{Authorization:'Bearer '+'x'.repeat(48)}}),env)).status,200);assert.equal(calls,1);
 assert.equal((await Worker.fetch(new Request('https://service/admin/state'),{...env,OPS_ADMIN_TOKEN:''})).status,503);
});

test('signed policy publication is revision-checked; allowlist is private; rollback requires a new signature/revision',async()=>{
 const f=await operationsFixture();f.access={mode:'allowlist',users:[{id:'123456789012345678',note:'private tester'}]};
 assert.equal((await f.publish()).status,200);
 const visible=await (await f.hub.fetch(new Request('https://hub/policy'))).json();assert.deepEqual(visible,await f.envelope(f.policy));assert(!JSON.stringify(visible).includes('private tester'));
 assert.equal((await f.publish()).status,409);
 f.policy={...f.policy,revision:2};f.policy.features.items.enabled=false;assert.equal((await f.publish()).status,200);
 const history=await (await f.hub.fetch(new Request('https://hub/admin/history'))).json();assert.equal(history.length,1);assert.equal(history[0].revision,1);
 const rollback={...JSON.parse(history[0].envelope.payload),revision:3};assert.equal((await f.publish(rollback,history[0].access,2)).status,200);
 assert.equal((await f.hub.policyState()).policy.features.items.enabled,true);
});

test('tampering, expired policies and excessive admin bodies cannot change state',async()=>{
 const f=await operationsFixture(),envelope=await f.envelope(f.policy);envelope.payload=envelope.payload.replace('1.4.9','9.9.9');
 const put=body=>f.hub.fetch(new Request('https://hub/admin/state',{method:'PUT',body:JSON.stringify(body)}));
 assert.equal((await put({expectedRevision:0,envelope,access:f.access})).status,400);
 assert.equal((await f.publish({...f.policy,expiresAt:Date.now()-1})).status,400);
 assert.equal((await f.hub.fetch(new Request('https://hub/admin/state',{method:'PUT',body:'x'.repeat(262145)}))).status,413);
 assert.equal((await f.hub.policyState()).revision,0);
});

test('maintenance and private access changes block already-linked users while unlink remains available',async()=>{
 const f=await operationsFixture();await f.publish();
 await f.storage.put('agent:pc-a',{user:'user-a',version:'1.4.9'});await f.storage.put('user:user-a',{agent:'pc-a'});
 assert.equal((await (await f.hub.discord(command('아이템',[{name:'이름',value:'가죽'}]))).json()).type,5);
 f.policy={...f.policy,revision:2};f.access={mode:'allowlist',users:[]};await f.publish();
 const blocked=await (await f.hub.discord(command('아이템',[{name:'이름',value:'가죽'}]))).json();assert.match(blocked.data.content,/허용된 사용자/);
 assert.equal((await f.storage.list({prefix:'query:'})).size,0);
 const oldFetch=globalThis.fetch;globalThis.fetch=async()=>new Response('{}');
 try{assert.match((await (await f.hub.discord(command('연결해제'))).json()).data.content,/해제했습니다/);await Promise.all(f.tasks);}finally{globalThis.fetch=oldFetch;}
});

test('feature maintenance applies to pairing approval and in-flight sensitive results',async()=>{
 const f=await operationsFixture();await f.publish();await f.storage.put('agent:pc-a',{user:'user-a',version:'1.4.9'});await f.storage.put('user:user-a',{agent:'pc-a'});
 const c=command('아이템',[{name:'이름',value:'가죽'}]);await f.hub.discord(c);
 f.policy={...f.policy,revision:2};f.policy.features.items={enabled:false,reason:'아이템 점검'};f.policy.features.link={enabled:false,reason:'신규 연결 점검'};await f.publish();
 assert.equal(await f.storage.get('query:'+c.id),undefined);
 let delivered=0;const before=globalThis.fetch;globalThis.fetch=async()=>{delivered++;return new Response('{}');};
 try{await f.hub.webSocketMessage(f.socket,JSON.stringify({type:'result',id:c.id,result:{ok:true,items:[]}}));await Promise.all(f.tasks);assert.equal(delivered,0);}finally{globalThis.fetch=before;}
 await f.storage.put('pending:pc-a',{nonce:'nonce',user:'user-b',name:'test',until:Date.now()+10000});
 await f.hub.webSocketMessage(f.socket,JSON.stringify({type:'approve',nonce:'nonce'}));assert.equal((await f.storage.get('agent:pc-a')).user,'user-a');assert.match(f.socket.messages.at(-1).message,/신규 연결 점검/);
});

test('minimum version, exact blocked version and policy expiry stop remote requests',async()=>{
 const f=await operationsFixture();await f.publish();await f.storage.put('user:user-a',{agent:'pc-a'});
 for(const v of ['', '1.4.8']){await f.storage.put('agent:pc-a',{user:'user-a',version:v});assert.match((await (await f.hub.discord(command('연결상태'))).json()).data.content,/새 버전/);}
 f.policy={...f.policy,revision:2,blocked:['1.4.9']};await f.publish();await f.storage.put('agent:pc-a',{user:'user-a',version:'1.4.9'});assert.match((await (await f.hub.discord(command('연결상태'))).json()).data.content,/새 버전/);
 const state=await f.storage.get('ops:current');const p=JSON.parse(state.envelope.payload);p.expiresAt=Date.now()-1;state.envelope=await f.envelope(p);await f.storage.put('ops:current',state);
 assert.match((await (await f.hub.discord(command('연결상태'))).json()).data.content,/유효기간/);
});

test('legacy grace permits absent version only and never bypasses explicit blocked or malformed versions',async()=>{
 const f=await operationsFixture();f.policy.legacyUntil=Date.now()+60000;f.policy.blocked=['1.4.9'];assert.equal((await f.publish()).status,200);
 for(const v of ['', '1.4.8','garbage','1.4.9']){
  const r=await f.hub.fetch(new Request('https://hub/register',{method:'POST',headers:{'X-Client-Hash':'legacy-'+v,'X-Erinn-Version':v}}));
  assert.equal(r.status,v===''?200:403);
 }
 await f.storage.put('agent:pc-a',{user:'user-a'});await f.storage.put('user:user-a',{agent:'pc-a'});
 assert.match((await (await f.hub.discord(command('연결상태'))).json()).data.content,/PC와 연결/);
 const query=command('아이템',[{name:'이름',value:'가죽'}]);assert.equal((await (await f.hub.discord(query)).json()).type,5);
 const pending=await f.storage.get('query:'+query.id);assert.equal(await f.hub.authorized(pending),true);
 const clock=Date.now;Date.now=()=>f.policy.legacyUntil;
 try{
  assert.equal(await f.hub.authorized(pending),false);
  const blocked=(await (await f.hub.discord(command('연결상태'))).json()).data.content;
  assert.match(blocked,/새 버전/);assert.match(blocked,/https:\/\/example.com\/ErinnDesk.exe/);
  assert.match((await (await f.hub.discord(command('연결해제'))).json()).data.content,/해제했습니다/);
 }finally{Date.now=clock;}
});

test('legacy grace still enforces maintenance, allowlist and policy expiration',async()=>{
 const f=await operationsFixture();f.policy.legacyUntil=Date.now()+60000;f.policy.features.items={enabled:false,reason:'아이템 점검'};await f.publish();
 await f.storage.put('agent:pc-a',{user:'user-a'});await f.storage.put('user:user-a',{agent:'pc-a'});
 assert.match((await (await f.hub.discord(command('아이템',[{name:'이름',value:'가죽'}]))).json()).data.content,/아이템 점검/);
 f.policy={...f.policy,revision:2};f.access={mode:'allowlist',users:[]};await f.publish();
 assert.match((await (await f.hub.discord(command('연결상태'))).json()).data.content,/허용된 사용자/);
 const clock=Date.now;Date.now=()=>f.policy.expiresAt;
 try{assert.match((await (await f.hub.discord(command('연결상태'))).json()).data.content,/유효기간/);}finally{Date.now=clock;}
});

test('legacy grace timestamp is optional, bounded and cannot silently be renewed with the policy',async()=>{
 for(const value of [-1,true,'tomorrow',1.5]){
  const f=await operationsFixture();f.policy.legacyUntil=value;assert.equal((await f.publish()).status,400);
 }
 const f=await operationsFixture();f.policy.legacyUntil=f.policy.expiresAt+1;assert.equal((await f.publish()).status,400);
 f.policy.legacyUntil=Date.now()+10000;assert.equal((await f.publish()).status,200);
 const deadline=f.policy.legacyUntil;f.policy={...f.policy,revision:2,expiresAt:f.policy.expiresAt+10000};assert.equal((await f.publish()).status,200);
 assert.equal((await f.hub.policyState()).policy.legacyUntil,deadline);
 f.policy={...f.policy,revision:3,legacyUntil:0};assert.equal((await f.publish()).status,200);
 assert.match(await f.hub.denied('discord',null,''),/새 버전/);
});

test('blacklist blocks linked commands and late results but allows unlink without leaking memo',async()=>{
 const f=await operationsFixture();await f.publish();
 await f.storage.put('agent:pc-a',{user:'user-a',version:'1.4.9'});await f.storage.put('user:user-a',{agent:'pc-a'});
 const c=command('아이템',[{name:'이름',value:'가죽'}]);await f.hub.discord(c);
 const state=await f.storage.get('ops:current');state.access={mode:'all',users:[],blockedUsers:[{id:'user-a',note:'PRIVATE NOTE',reason:'운영 정책 위반'}]};await f.storage.put('ops:current',state);
 const blocked=await (await f.hub.discord(command('아이템',[{name:'이름',value:'가죽'}]))).json();assert.match(blocked.data.content,/사유 : 운영 정책 위반/);assert.doesNotMatch(blocked.data.content,/PRIVATE NOTE/);
 let delivered=0;const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{delivered++;return new Response('{}');};
 try{await f.hub.webSocketMessage(f.socket,JSON.stringify({type:'result',id:c.id,result:{ok:true,items:[]}}));await Promise.all(f.tasks);assert.equal(delivered,0);assert.match((await (await f.hub.discord(command('연결해제'))).json()).data.content,/해제했습니다/);await Promise.all(f.tasks);}finally{globalThis.fetch=oldFetch;}
});
