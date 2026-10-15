'use strict';
(() => {
 const $=s=>document.querySelector(s);
 let token='';
 function acceptSession(){const launchToken=new URLSearchParams(location.hash.slice(1)).get('session');if(launchToken){sessionStorage.setItem('erinn-admin-session',launchToken);history.replaceState(null,'',location.pathname);}token=sessionStorage.getItem('erinn-admin-session')||'';}
 acceptSession();
 const names={overview:'운영 현황',versions:'버전 관리',features:'디스코드 기능 점검',access:'디스코드 사용자 관리',history:'변경 이력'};
 const featureNames={discord:'디스코드 전체',link:'신규 연결',items:'아이템 조회',capture:'스크린샷'};
 const modes={all:'전체 허용',allowlist:'허용 목록만',maintenance:'전체 점검'};
 let remote=null,policy=null,access=null,dirty=false,busy=false,ticket=null,historyRows=[],tab='overview',urlVersion=null;
 const node=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
 const clone=x=>JSON.parse(JSON.stringify(x));
 const date=ms=>ms?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',dateStyle:'medium',timeStyle:'short'}).format(ms):'미설정';
 const localInput=ms=>ms?new Date(ms+9*3600000).toISOString().slice(0,16):'';
 const inputTime=value=>value?Date.parse(value+':00+09:00'):0;
 function status(text,error=false){const n=$('#status');n.hidden=!text;n.textContent=text;n.classList.toggle('error',error);}
 async function api(path,body,raw=false){
  const response=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:{'X-Erinn-Admin':token,...(!raw&&body!==undefined?{'Content-Type':'application/json'}:{})},...(body===undefined?{}:{body:raw?body:JSON.stringify(body)})});
  const data=await response.json();if(!response.ok)throw Error(data.error||'요청을 처리하지 못했습니다.');return data;
 }
 function setBusy(value){busy=value;document.querySelectorAll('[data-edit]').forEach(n=>n.disabled=busy||!remote);$('#refresh').disabled=busy;$('#commit').disabled=busy;$('#cancelApply').disabled=busy;}
 function mark(){dirty=true;$('#draftStatus').textContent='아직 적용하지 않은 변경이 있습니다.';}
 function initialPolicy(){return {latest:'1.4.9',minimum:'1.4.9',scope:'discord',blocked:[],legacyUntil:0,message:'새 버전의 Erinn Desk를 다운로드해 주세요.',features:Object.fromEntries(Object.keys(featureNames).map(k=>[k,{enabled:true,reason:''}])),releases:{}};}
 function choose(next){tab=next;document.querySelectorAll('[data-page]').forEach(n=>n.hidden=n.dataset.page!==next);document.querySelectorAll('[data-tab]').forEach(n=>n.classList.toggle('selected',n.dataset.tab===next));$('#pageTitle').textContent=names[next];if(next==='history'&&remote)loadHistory();}
 function selects(){
  document.querySelectorAll('select').forEach(select=>{
   if(select.dataset.enhanced)return;select.dataset.enhanced='true';const wrapper=node('div',undefined,'choice'),button=node('button');button.type='button';button.setAttribute('role','combobox');button.setAttribute('aria-expanded','false');button.setAttribute('aria-label',select.closest('label').firstChild.textContent.trim());button.dataset.edit='';const list=node('div',undefined,'choice-list');list.hidden=true;list.setAttribute('role','listbox');select.after(wrapper);wrapper.append(button,list);select.hidden=true;
   const paint=()=>{button.replaceChildren(node('span',select.selectedOptions[0]?.textContent||''),node('span','⌄','choice-arrow'));};paint();select.addEventListener('change',paint);
   [...select.options].forEach(option=>{const item=node('button',option.textContent);item.type='button';item.setAttribute('role','option');item.onclick=()=>{select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));list.hidden=true;button.setAttribute('aria-expanded','false');button.focus();};list.append(item);});
   button.onclick=()=>{list.hidden=!list.hidden;button.setAttribute('aria-expanded',String(!list.hidden));if(!list.hidden)list.querySelector('button')?.focus();};wrapper.addEventListener('keydown',e=>{if(e.key==='Escape'){list.hidden=true;button.setAttribute('aria-expanded','false');button.focus();}if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();const options=[...list.querySelectorAll('button')];list.hidden=false;button.setAttribute('aria-expanded','true');const i=options.indexOf(document.activeElement);options[(i+(e.key==='ArrowDown'?1:-1)+options.length)%options.length]?.focus();}});
   document.addEventListener('click',e=>{if(!wrapper.contains(e.target)){list.hidden=true;button.setAttribute('aria-expanded','false');}});
  });
 }
 function read(){
  policy.latest=$('#latest').value.trim();policy.minimum=$('#minimum').value.trim();policy.scope=$('#scope').value;policy.blocked=$('#blocked').value.split(',').map(s=>s.trim()).filter(Boolean);policy.message=$('#updateMessage').value;policy.legacyUntil=$('#legacyUntil').value===localInput(policy.legacyUntil)?(policy.legacyUntil||0):inputTime($('#legacyUntil').value);
  for(const key of Object.keys(featureNames))policy.features[key]={enabled:$('#feature-'+key).checked,reason:$('#reason-'+key).value};access.mode=$('#accessMode').value;
  return {expectedRevision:remote.revision,policy:clone(policy),access:clone(access)};
 }
 function renderBlockedUsers(){
  const root=$('#blockedUsers');root.replaceChildren();$('#blockedUserCount').textContent=access.blockedUsers.length+'명';
  if(!access.blockedUsers.length)root.append(node('p','등록된 차단 사용자가 없습니다.','empty'));
  for(const user of access.blockedUsers){
   const record=node('article',undefined,'release-record'),head=node('div',undefined,'release-record-head'),remove=node('button','제거','small');remove.dataset.edit='';remove.onclick=()=>{access.blockedUsers=access.blockedUsers.filter(u=>u.id!==user.id);renderBlockedUsers();mark();};head.append(node('strong',user.id),remove);record.append(head);
   for(const [label,text] of [['관리 메모',user.note||'—'],['사용자 안내','디스코드 기능 이용이 제한된 계정입니다.'+(user.reason.trim()?'\n사유 : '+user.reason.trim():'')]]){const line=node('div',undefined,'blocked-detail');line.append(node('span',label),node('p',text));record.append(line);}root.append(record);
  }
 }
 function renderUsers(){
  $('#userCount').textContent=access.users.length+'명';const root=$('#users');root.replaceChildren();
  if(!access.users.length){const r=node('tr'),c=node('td','등록된 사용자가 없습니다.','empty');c.colSpan=3;r.append(c);root.append(r);}
  access.users.forEach(user=>{const row=node('tr'),action=node('td'),button=node('button','제거','small');button.dataset.edit='';button.onclick=()=>{access.users=access.users.filter(u=>u.id!==user.id);renderUsers();mark();};action.append(button);row.append(node('td',user.id),node('td',user.note||'—'),action);root.append(row);});
 }
 function renderReleases(){
  const root=$('#releases');root.replaceChildren();const entries=Object.entries(policy.releases).sort((a,b)=>b[0].localeCompare(a[0],undefined,{numeric:true}));
  $('#releaseCount').textContent=entries.length+'개';
  if(!entries.length)root.append(node('p','등록된 배포 파일이 없습니다.','empty'));
  for(const [v,r]of entries){
   const record=node('article',undefined,'release-record'),head=node('div',undefined,'release-record-head'),info=node('div',undefined,'release-version');
   info.append(node('strong',v));if(v===policy.latest)info.append(node('span','최신','version-label'));info.append(node('span',(r.size/1024/1024).toFixed(1)+' MB','size'));head.append(info);
   if(remote.policy?.releases[v]){const button=node('button','주소 변경','small');button.dataset.edit='';button.dataset.versionUrl=v;button.onclick=()=>{urlVersion=v;$('#urlDialogTitle').textContent=v+' 다운로드 주소 변경';$('#newReleaseUrl').value=r.url;$('#urlStatus').textContent='';$('#urlStatus').classList.remove('error');$('#urlDialog').showModal();};head.append(button);}else head.append(node('span','미적용','hint'));
   const url=node('div',undefined,'release-detail'),link=node('a',r.url);link.href=r.url;link.target='_blank';link.rel='noopener noreferrer';url.append(node('span','다운로드'),link);
   const hash=node('div',undefined,'release-detail');hash.append(node('span','SHA256'),node('code',r.sha256));record.append(head,url,hash);root.append(record);
  }
 }
 function accessHint(){const mode=$('#accessMode').value;$('#accessHint').textContent=mode==='all'?'기존 이용자를 포함해 버전 조건을 충족한 사용자에게 허용합니다.':mode==='allowlist'?'목록에 등록된 사용자만 이용할 수 있습니다. 구버전 유예 중에도 이 제한은 적용됩니다.':'디스코드 기능을 일시 중단합니다. 연결 해제는 계속 가능합니다.';}
 function fill(){
  policy=clone(remote.policy||initialPolicy());access=clone(remote.access||{mode:'allowlist',users:[]});access.blockedUsers??=[];if(!remote.policy)access.mode='allowlist';
  for(const [id,value]of Object.entries({latest:policy.latest,minimum:policy.minimum,scope:policy.scope,blocked:policy.blocked.join(', '),updateMessage:policy.message,legacyUntil:localInput(policy.legacyUntil),accessMode:access.mode})){$('#'+id).value=value;$('#'+id).dispatchEvent(new Event('change'));}
  const root=$('#featureForms');root.replaceChildren();
  for(const [key,name]of Object.entries(featureNames)){
   const f=policy.features[key],box=node('div',undefined,'feature'),title=node('div',undefined,'feature-title'),label=node('label',undefined,'switch'),input=node('input');input.type='checkbox';input.id='feature-'+key;input.checked=f.enabled;input.dataset.edit='';label.append(node('span','사용'),input);title.append(node('strong',name),label);const reasonLabel=node('label','점검 시 사용자 안내'),reason=node('input');reason.id='reason-'+key;reason.maxLength=300;reason.value=f.reason;reason.placeholder='예: 기능을 점검하고 있습니다. 잠시 후 이용해 주세요.';reason.dataset.edit='';reasonLabel.append(reason);box.append(title,reasonLabel);root.append(box);
  }
  $('#releaseVersion').value=policy.latest;$('#releaseFile').value='';$('#releaseFileName').textContent='선택한 파일 없음';releaseStatus('');
  renderUsers();renderBlockedUsers();renderReleases();accessHint();dirty=false;$('#draftStatus').textContent=remote.policy?'서버 설정과 동일합니다.':'최초 정책입니다. 배포 파일과 접근 대상을 확인해주세요.';setBusy(false);
 }
 async function load(){
  setBusy(true);status('서버 상태를 확인하고 있습니다.');
  try{
   const result=await api('/api/state');remote=result.state;
   $('#healthLabel').textContent=result.health.ok?'정상 응답':'확인 필요';$('#healthLabel').className=result.health.ok?'good':'error';$('#commitLabel').textContent=result.health.commit?'배포 '+result.health.commit.slice(0,12):'배포 정보 없음';$('#endpoint').textContent=result.endpoint;$('#keyLabel').textContent=result.keyReady?'이 PC에 암호화 저장됨':'관리자 초기화 필요';$('#setup').hidden=!!remote;
   $('#latestLabel').textContent=remote?.policy?.latest||'정책 미게시';$('#minimumLabel').textContent='최소 지원 '+(remote?.policy?.minimum||'—');$('#revisionLabel').textContent=remote?'정책 #'+remote.revision:'정책 미확인';$('#expiryLabel').textContent=remote?.policy?Math.max(0,Math.ceil((remote.policy.expiresAt-Date.now())/86400000))+'일 남음':'—';$('#graceLabel').textContent=date(remote?.policy?.legacyUntil);
   const summary=$('#featureSummary');summary.replaceChildren();for(const [k,v]of Object.entries(remote?.policy?.features||{}))summary.append(node('span',featureNames[k]+' · '+(v.enabled?'사용':'점검'),'badge'));
   if(remote)fill();else{$('#draftStatus').textContent='서버 연결 준비 후 편집할 수 있습니다.';}
   status(result.errors.join('\n'),!!result.errors.length);if(tab==='history'&&remote)await loadHistory();
  }catch(e){status(e.message,true);}finally{setBusy(false);}
 }
 async function loadHistory(){
  try{historyRows=(await api('/api/history')).sort((a,b)=>b.revision-a.revision);const root=$('#history');root.replaceChildren();if(!historyRows.length)root.append(node('p','이전 변경 이력이 없습니다.','empty'));
   for(const r of historyRows){const row=node('div',undefined,'history-entry'),text=node('div');text.append(node('strong','정책 #'+r.revision+' · '+r.policy.latest),node('p',date(r.changedAt)+' · '+modes[r.access.mode]));const button=node('button','이 설정으로 복원','small');button.dataset.edit='';button.onclick=()=>preview(true,r.revision);row.append(text,button);root.append(row);}
  }catch(e){status(e.message,true);}
 }
 function changes(before,after){
  const root=$('#changes');root.replaceChildren();const values=(s)=>{const p=s.policy||{},a=s.access||{};return {'최신 버전':p.latest||'미게시','최소 지원 버전':p.minimum||'—','차단 버전':(p.blocked||[]).join(', ')||'없음','제한 범위':p.scope==='all'?'모든 CLI 요청':'디스코드 기능','구버전 유예 종료':date(p.legacyUntil),'업데이트 안내':p.message||'—','접근 모드':modes[a.mode]||'—','허용 사용자':(a.users||[]).map(u=>u.id+(u.note?' · '+u.note:'')).join('\n')||'없음','차단 사용자':(a.blockedUsers||[]).map(u=>u.id+'\n관리 메모: '+(u.note||'없음')+'\n사용자 안내 사유: '+(u.reason||'없음')).join('\n\n')||'없음','정책 만료':date(p.expiresAt),...Object.fromEntries(Object.entries(p.features||{}).map(([k,f])=>[featureNames[k],(f.enabled?'사용':'점검')+(f.reason?' · '+f.reason:'')])),...Object.fromEntries(Object.entries(p.releases||{}).map(([v,r])=>['배포 파일 '+v,r.url+'\n'+r.sha256]))};};const a=values(before),b=values(after);
  for(const key of new Set([...Object.keys(a),...Object.keys(b)])){if(a[key]===b[key])continue;const item=node('div',undefined,'change');item.append(node('strong',key),node('p','현재 · '+(a[key]||'없음'),'before'),node('p','변경 · '+(b[key]||'없음')));root.append(item);}
  if(!root.childNodes.length)root.append(node('p','설정은 유지하고 정책 유효기간을 갱신합니다.','hint'));
 }
 async function preview(restore=false,revision=null){
  if(busy||!remote)return;setBusy(true);status('변경 내용을 확인하고 있습니다.');
  try{const result=await api(restore?'/api/restore':'/api/prepare',restore?{expectedRevision:remote.revision,revision}:read());ticket=result.ticket;changes(result.before,result.after);$('#confirmHint').textContent=`정책 #${remote.revision} → #${result.after.policy.revision} · ${restore?'선택한 이력으로 복원합니다. 작성 중인 다른 변경은 적용되지 않습니다.':'아래 내용을 확인하면 운영 서버에 적용합니다.'}`;$('#confirmError').textContent='';$('#confirm').showModal();status('');}catch(e){status(e.message,true);}finally{setBusy(false);}
 }
 document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>choose(b.dataset.tab));
 document.addEventListener('input',e=>{if(e.target.matches('#latest,#minimum,#blocked,#updateMessage,#legacyUntil,[id^="reason-"],[id^="feature-"]'))mark();});
 document.addEventListener('change',e=>{if(e.target.matches('#scope,#accessMode')){mark();accessHint();}});
 $('#clearGrace').onclick=()=>{$('#legacyUntil').value='';mark();};
 $('#addBlockedUser').onclick=()=>{const id=$('#blockedUserId').value.trim(),note=$('#blockedUserNote').value.trim(),reason=$('#blockedUserReason').value.trim();if(!/^\d{17,22}$/.test(id)){status('디스코드 사용자 ID는 17~22자리 숫자로 입력하세요.',true);return;}if(access.blockedUsers.some(u=>u.id===id)){status('이미 차단 목록에 등록된 사용자입니다.',true);return;}access.blockedUsers.push({id,note,reason});renderBlockedUsers();for(const field of ['blockedUserId','blockedUserNote','blockedUserReason'])$('#'+field).value='';mark();status('');};
 $('#addUser').onclick=()=>{const id=$('#userId').value.trim(),note=$('#userNote').value.trim();if(!/^\d{17,22}$/.test(id)){status('디스코드 사용자 ID는 17~22자리 숫자로 입력하세요.',true);return;}if(access.users.some(u=>u.id===id)){status('이미 등록된 사용자입니다.',true);return;}access.users.push({id,note});renderUsers();$('#userId').value='';$('#userNote').value='';mark();status('');};
 function releaseStatus(message,kind='') {const label=$('#verifyStatus');label.textContent=message;label.classList.toggle('error',kind==='error');label.classList.toggle('good',kind==='success');}
 $('#browseReleaseFile').onclick=e=>{e.preventDefault();$('#releaseFile').click();};
 $('#releaseFile').onchange=()=>{$('#releaseFileName').textContent=$('#releaseFile').files[0]?.name||'선택한 파일 없음';releaseStatus('');};
 $('#verifyFile').onclick=async()=>{
  const file=$('#releaseFile').files[0],v=$('#releaseVersion').value.trim(),url=$('#releaseUrl').value.trim();
  const invalid=(message,field)=>{releaseStatus(message,'error');$(field==='#releaseFile'?'#browseReleaseFile':field).focus();};
  if(!/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(v)){invalid('등록할 버전을 1.4.9 형식으로 입력하세요. v는 붙이지 않습니다.','#releaseVersion');return;}
  if(!file){invalid('최종 EXE 파일에서 파일 선택을 눌러 ErinnDesk.exe를 선택하세요.','#releaseFile');return;}
  if(!file.size){invalid('선택한 EXE 파일이 비어 있습니다. 다른 파일을 선택하세요.','#releaseFile');return;}
  if(file.size>512*1024*1024){invalid('선택한 파일은 '+(file.size/1024/1024).toFixed(1)+'MB입니다. 512MB 이하의 EXE를 선택하세요.','#releaseFile');return;}
  try{const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.hash)throw Error();}catch{invalid('게시된 파일의 직접 다운로드 HTTPS 주소를 입력하세요.','#releaseUrl');return;}
  setBusy(true);releaseStatus('선택한 파일과 게시된 파일을 비교하고 있습니다…');
  try{const r=await api('/api/release?'+new URLSearchParams({version:v,url}),file,true);if(policy.releases[v]&&(policy.releases[v].sha256!==r.release.sha256||policy.releases[v].size!==r.release.size))throw Error('기존 버전 파일을 교체할 수 없습니다. 새 버전을 입력하세요.');policy.releases[v]=r.release;$('#latest').value=v;renderReleases();mark();releaseStatus('파일이 일치합니다. 변경 내용 확인 후 적용해주세요.','success');}catch(e){releaseStatus(e.message,'error');}finally{setBusy(false);}
 };

 $('#cancelUrl').onclick=()=>$('#urlDialog').close();
 $('#urlDialog').addEventListener('cancel',e=>{if(busy)e.preventDefault();});
 $('#verifyUrl').onclick=async()=>{
  if(busy||!urlVersion)return;setBusy(true);const message=$('#urlStatus');message.classList.remove('error');message.textContent='새 주소의 파일을 검증하고 있습니다…';
  try{const result=await api('/api/release-url',{version:urlVersion,url:$('#newReleaseUrl').value.trim()});policy.releases[result.version]=result.release;renderReleases();mark();$('#urlDialog').close();releaseStatus(result.version+' 주소 검증 완료. 변경 내용 확인 후 적용해주세요.','success');}
  catch(e){message.textContent=e.message;message.classList.add('error');}finally{setBusy(false);}
 };
 const requestReload=()=>{if(dirty)$('#discardDialog').showModal();else load();};$('#refresh').onclick=requestReload;$('#discard').onclick=requestReload;$('#keepDraft').onclick=()=>$('#discardDialog').close();$('#confirmDiscard').onclick=()=>{$('#discardDialog').close();load();};
 window.addEventListener('hashchange',()=>{if(new URLSearchParams(location.hash.slice(1)).has('session')){acceptSession();requestReload();}});
 $('#preview').onclick=()=>preview();$('#renew').onclick=()=>preview();$('#loadHistory').onclick=loadHistory;$('#cancelApply').onclick=()=>{$('#confirm').close();ticket=null;};
 $('#commit').onclick=async()=>{if(busy||!ticket)return;const pending=ticket;ticket=null;setBusy(true);try{await api('/api/commit',{ticket:pending});$('#confirm').close();await load();status('운영 서버에 적용했습니다.');}catch(e){$('#confirmError').textContent=e.message+' 새로고침으로 서버 상태를 확인한 뒤 다시 진행해주세요.';}finally{setBusy(false);if(!ticket)$('#commit').disabled=true;}};
 $('#confirm').addEventListener('close',()=>{ticket=null;});
 $('#theme').onclick=()=>{const light=document.documentElement.dataset.theme!=='light';document.documentElement.dataset.theme=light?'light':'dark';$('#theme').textContent=light?'라이트 모드':'다크 모드';localStorage.setItem('erinn-admin-theme',light?'light':'dark');};
 if(localStorage.getItem('erinn-admin-theme')==='light')$('#theme').click();
 window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
 selects();setBusy(true);if(token)load();else{status('관리 도구를 실행해 열린 주소로 접속해주세요. 이 페이지에는 관리 세션이 없습니다.',true);$('#draftStatus').textContent='관리 세션이 필요합니다.';}
})();
