// Public, signed policy and private access list are intentionally separate.
export const FEATURES=['discord','link','items','capture'];
export const version=v=>typeof v==='string'&&/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(v);
export function compare(a,b){const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]-y[i];return 0;}
export function validatePolicy(p,now=Date.now()){
 if(!p||p.schema!==1||!Number.isSafeInteger(p.revision)||p.revision<1)throw Error('정책 버전을 확인하세요.');
 if(!Number.isSafeInteger(p.issuedAt)||!Number.isSafeInteger(p.expiresAt)||p.issuedAt>now+300000||p.expiresAt<=now||p.expiresAt-p.issuedAt>90*86400000)throw Error('정책 유효기간은 최대 90일입니다.');
 if(!version(p.latest)||!version(p.minimum)||compare(p.minimum,p.latest)>0||!['discord','all'].includes(p.scope))throw Error('지원 버전을 확인하세요.');
 if(!Array.isArray(p.blocked)||p.blocked.length>100||p.blocked.some(v=>!version(v)))throw Error('차단 버전을 확인하세요.');
 if(p.legacyUntil!==undefined&&(!Number.isSafeInteger(p.legacyUntil)||p.legacyUntil<0||p.legacyUntil>p.expiresAt))throw Error('구버전 유예 종료는 정책 유효기간 이내의 시각이어야 합니다.');
 if(typeof p.message!=='string'||p.message.length>500)throw Error('안내 문구는 최대 500자입니다.');
 for(const name of FEATURES){const f=p.features?.[name];if(!f||typeof f.enabled!=='boolean'||typeof f.reason!=='string'||f.reason.length>300)throw Error('기능 설정을 확인하세요.');}
 if(!p.releases||typeof p.releases!=='object'||Array.isArray(p.releases)||Object.keys(p.releases).length>500)throw Error('배포 목록을 확인하세요.');
 for(const [v,r]of Object.entries(p.releases)){
  if(!version(v)||!r||!(/^[a-f0-9]{64}$/).test(r.sha256)||!Number.isSafeInteger(r.size)||r.size<=0||typeof r.url!=='string'||r.url.length>2048)throw Error('배포 파일 정보를 확인하세요.');
  const u=new URL(r.url);if(u.protocol!=='https:'||u.username||u.password||u.hash)throw Error('HTTPS 다운로드 주소를 입력하세요.');
 }
 if(!p.releases[p.latest])throw Error('최신 버전의 배포 파일 정보가 필요합니다.');
 return p;
}
export async function verifyEnvelope(envelope,publicKey){
 if(!envelope||typeof envelope.payload!=='string'||envelope.payload.length>200000||typeof envelope.signature!=='string'||!(/^[a-f0-9]{64}$/).test(publicKey||''))throw Error('서명 설정을 확인하세요.');
 const key=await crypto.subtle.importKey('raw',Uint8Array.from(publicKey.match(/../g),x=>parseInt(x,16)),{name:'Ed25519'},false,['verify']);
 let signature;try{signature=Uint8Array.from(atob(envelope.signature),c=>c.charCodeAt(0));}catch{throw Error('서명이 올바르지 않습니다.');}
 if(signature.length!==64||!await crypto.subtle.verify('Ed25519',key,signature,new TextEncoder().encode(envelope.payload)))throw Error('서명이 올바르지 않습니다.');
 return validatePolicy(JSON.parse(envelope.payload));
}
export function validateAccess(a){
 if(!a||!['all','allowlist','maintenance'].includes(a.mode)||!Array.isArray(a.users)||a.users.length>10000)throw Error('사용자 허용 설정을 확인하세요.');
 const seen=new Set();for(const u of a.users){if(!u||!/^\d{17,22}$/.test(u.id)||typeof u.note!=='string'||u.note.length>100||seen.has(u.id))throw Error('디스코드 ID와 메모를 확인하세요.');seen.add(u.id);}
 if(a.blockedUsers!==undefined){
  if(!Array.isArray(a.blockedUsers)||a.blockedUsers.length>10000)throw Error('차단 사용자 목록을 확인하세요.');
  const blocked=new Set();for(const u of a.blockedUsers){if(!u||!/^\d{17,22}$/.test(u.id)||typeof u.note!=='string'||u.note.length>100||typeof u.reason!=='string'||u.reason.length>300||blocked.has(u.id))throw Error('차단 사용자 ID, 메모(100자), 안내 사유(300자)를 확인하세요.');blocked.add(u.id);}
 }
 return a;
}
export function denial(policy,access,feature,user,clientVersion){
 if(!policy)return null; // Explicit bootstrap compatibility, until the first publication.
 if(policy.expiresAt<=Date.now())return '운영 설정의 유효기간이 만료되어 디스코드 연결을 일시 중단했습니다.';
 for(const name of ['discord',feature]){const f=policy.features[name];if(!f?.enabled)return f?.reason||'디스코드 기능을 점검하고 있습니다.';}
 if(access?.mode==='maintenance')return '디스코드 기능을 점검하고 있습니다.';
 const blockedUser=user&&(access?.blockedUsers||[]).find(u=>u.id===user);
 if(blockedUser)return '디스코드 기능 이용이 제한된 계정입니다.'+(blockedUser.reason.trim()?'\n사유 : '+blockedUser.reason.trim():'');
 if(user&&access?.mode==='allowlist'&&!access.users.some(u=>u.id===user))return '현재 허용된 사용자만 디스코드 기능을 이용할 수 있습니다.';
 const legacy=clientVersion===''&&Number.isSafeInteger(policy.legacyUntil)&&policy.legacyUntil>Date.now();
 if(clientVersion!==undefined&&!legacy&&(!version(clientVersion)||compare(clientVersion,policy.minimum)<0||policy.blocked.includes(clientVersion))){
  const message=policy.message||'새 버전의 Erinn Desk를 다운로드해 주세요.',url=policy.releases[policy.latest]?.url;
  return message+(url&&message.length+url.length<1900?'\n다운로드: '+url:'');
 }
 return null;
}
