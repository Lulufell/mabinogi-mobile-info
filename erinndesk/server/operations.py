"""Erinn Desk operations console. Secrets remain DPAPI-encrypted outside Git."""
import base64, copy, ctypes, getpass, hashlib, json, os, re, secrets, sys, time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.request import Request, urlopen, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat, PrivateFormat, NoEncryption

ROOT=Path(__file__).resolve().parent
ADMIN_DIR=Path(os.environ.get('LOCALAPPDATA',str(Path.home())))/'ErinnDeskAdmin'
ENDPOINT='https://erinn-desk-remote.lulufell.workers.dev'
FEATURES={'discord':'디스코드 전체','link':'신규 연결','items':'아이템 조회','capture':'스크린샷'}

def protect(data,decode=False):
 class Blob(ctypes.Structure):_fields_=[('size',ctypes.c_uint32),('data',ctypes.POINTER(ctypes.c_ubyte))]
 buffer=ctypes.create_string_buffer(data);source=Blob(len(data),ctypes.cast(buffer,ctypes.POINTER(ctypes.c_ubyte)));out=Blob()
 api=ctypes.windll.crypt32.CryptUnprotectData if decode else ctypes.windll.crypt32.CryptProtectData
 if not api(ctypes.byref(source),None,None,None,None,1,ctypes.byref(out)):raise OSError('Windows 보안 저장소를 사용할 수 없습니다.')
 try:return ctypes.string_at(out.data,out.size)
 finally:ctypes.windll.kernel32.LocalFree(out.data)

def credentials():
 return json.loads(protect((ADMIN_DIR/'credentials.dat').read_bytes(),True))

def initialize():
 ADMIN_DIR.mkdir(parents=True,exist_ok=True)
 path=ADMIN_DIR/'credentials.dat'
 if path.exists():c=credentials()
 else:
  key=Ed25519PrivateKey.generate()
  c={'private':key.private_bytes(Encoding.Raw,PrivateFormat.Raw,NoEncryption()).hex(),'token':secrets.token_urlsafe(48)}
  path.write_bytes(protect(json.dumps(c).encode()))
 key=Ed25519PrivateKey.from_private_bytes(bytes.fromhex(c['private']))
 public=key.public_key().public_bytes(Encoding.Raw,PublicFormat.Raw).hex()
 trust={'url':ENDPOINT,'publicKey':public}
 (ROOT/'operations-public.json').write_text(json.dumps(trust,indent=2)+'\n',encoding='utf-8')
 config=json.loads((ROOT/'wrangler.jsonc').read_text(encoding='utf-8'));config['vars']['OPS_PUBLIC_KEY']=public
 (ROOT/'wrangler.jsonc').write_text(json.dumps(config,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
 print('초기화 완료. 비밀키와 관리자 인증정보는 이 Windows 계정으로 암호화하여 저장했습니다.')
 print('앱에 포함할 공개 설정:',ROOT/'operations-public.json')
 print('서버 인증정보 등록: python operations.py provision')
 print('비밀키 백업: python operations.py backup (별도 암호로 암호화)')

def provision():
 import subprocess
 c=credentials();script=ROOT/'node_modules/wrangler/bin/wrangler.js'
 node=Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
 result=subprocess.run([str(node) if node.exists() else 'node',str(script),'secret','put','OPS_ADMIN_TOKEN'],input=c['token']+'\n',text=True,cwd=ROOT)
 if result.returncode:raise ValueError('서버 인증정보 등록에 실패했습니다.')
 print('인증정보 등록 완료. 공개 키가 포함된 서버 코드는 기존 Git 배포 절차로 반영하세요.')

def api(path,body=None):
 c=credentials();raw=None if body is None else json.dumps(body,ensure_ascii=False).encode()
 req=Request(ENDPOINT+path,data=raw,method='GET' if body is None else 'PUT',headers={'Authorization':'Bearer '+c['token'],'Content-Type':'application/json','Accept':'application/json','User-Agent':'ErinnDeskAdmin/1.0'})
 class NoRedirect(HTTPRedirectHandler):
  def redirect_request(self,*args,**kwargs):return None
 try:
  with build_opener(NoRedirect).open(req,timeout=20) as response:return json.load(response)
 except HTTPError as e:
  try:message=json.loads(e.read(4096)).get('error','요청 실패')
  except Exception:message='요청 실패'
  raise ValueError(f'운영 요청 실패 (HTTP {e.code}): {message}') from None

def logical_policy(policy):
 p=copy.deepcopy(policy)
 if p.get('versionMode')=='recommend':
  advice=p.get('versionAdvice',{})
  p.update(scope='none',minimum=advice.get('minimum'),blocked=advice.get('blocked'))
  p.pop('versionMode',None);p.pop('versionAdvice',None)
 return p

def wire_policy(policy):
 p=copy.deepcopy(policy)
 p.pop('versionMode',None);p.pop('versionAdvice',None)
 if p.get('scope')=='none':
  p['versionMode']='recommend';p['versionAdvice']={'minimum':p['minimum'],'blocked':p['blocked']}
  p.update(scope='discord',minimum='0.0.0',blocked=[])
 return p

def seal(policy):
 key=Ed25519PrivateKey.from_private_bytes(bytes.fromhex(credentials()['private']))
 payload=json.dumps(wire_policy(policy),ensure_ascii=False,separators=(',',':'))
 return {'payload':payload,'signature':base64.b64encode(key.sign(payload.encode())).decode()}

def defaults():
 return {'schema':1,'revision':0,'issuedAt':0,'expiresAt':0,'latest':'1.4.9','minimum':'1.4.9','scope':'discord','blocked':[],'legacyUntil':0,
  'message':'새 버전의 Erinn Desk를 다운로드해 주세요.','features':{k:{'enabled':True,'reason':''} for k in FEATURES},'releases':{}}

def configure_legacy(policy):
 current=policy.get('legacyUntil',0);kst=timezone(timedelta(hours=9))
 print('현재 구버전 유예 종료:',datetime.fromtimestamp(current/1000,kst).strftime('%Y-%m-%d %H:%M KST') if current else '유예 없음')
 value=input('버전 미전송 구버전 유예 종료 (한국시간 YYYY-MM-DD HH:MM / 해제 / 유지 Enter): ').strip()
 if not value:return
 if value=='해제':policy['legacyUntil']=0;return
 try:until=int(datetime.strptime(value,'%Y-%m-%d %H:%M').replace(tzinfo=kst).timestamp()*1000)
 except ValueError:raise ValueError('한국시간 YYYY-MM-DD HH:MM 형식으로 입력하세요.') from None
 if not int(time.time()*1000)<until<=int(time.time()*1000)+30*86400000:raise ValueError('유예 종료는 현재부터 30일 이내의 미래 시각으로 입력하세요.')
 policy['legacyUntil']=until

def publish(state,policy,access):
 policy=copy.deepcopy(policy);policy.update(revision=state['revision']+1,issuedAt=int(time.time()*1000));policy['expiresAt']=policy['issuedAt']+30*86400000
 # Values are displayed before committing, including private access mode/count.
 print(json.dumps({'policy':policy,'access':access},ensure_ascii=False,indent=2))
 if policy.get('legacyUntil',0)>policy['expiresAt']:raise ValueError('구버전 유예 종료가 정책 만료보다 늦습니다. 유예 종료를 조정하세요.')
 if input('위 설정을 운영 서버에 적용하려면 적용 입력: ').strip()!='적용':print('취소했습니다.');return
 print(api('/admin/state',{'expectedRevision':state['revision'],'envelope':seal(policy),'access':access}))

def add_release(policy):
 v=input('버전 (예: 1.4.9): ').strip()
 if not re.fullmatch(r'\d{1,5}\.\d{1,5}\.\d{1,5}',v):raise ValueError('버전 형식을 확인하세요.')
 path=Path(input('최종 EXE 경로: ').strip().strip('"'));url=input('파일 직접 다운로드 HTTPS 주소: ').strip()
 if not url.startswith('https://'):raise ValueError('HTTPS 주소를 입력하세요.')
 with path.open('rb') as file:digest=hashlib.file_digest(file,'sha256').hexdigest()
 size=path.stat().st_size
 print('게시된 다운로드 파일을 확인하고 있습니다.')
 request=Request(url,headers={'User-Agent':'ErinnDeskAdmin/1.0'})
 with urlopen(request,timeout=60) as response:
  if not response.url.startswith('https://'):raise ValueError('다운로드 주소가 HTTPS가 아닙니다.')
  remote=hashlib.sha256();total=0
  while chunk:=response.read(1024*1024):
   total+=len(chunk)
   if total>size:raise ValueError('게시된 파일 크기가 다릅니다.')
   remote.update(chunk)
 if total!=size or remote.hexdigest()!=digest:raise ValueError('게시된 파일이 선택한 EXE와 다릅니다. 먼저 다운로드 파일을 게시하세요.')
 release={'sha256':digest,'size':size,'url':url}
 if v in policy['releases'] and policy['releases'][v]!=release:raise ValueError('이미 등록한 버전의 파일은 덮어쓸 수 없습니다. 새 버전을 사용하세요.')
 policy['releases'][v]=release;policy['latest']=v

def menu():
 while True:
  print('\nErinn Desk 운영 관리\n1. 상태 확인\n2. 새 버전 게시\n3. 지원/차단 버전\n4. 기능 점검\n5. 허용 사용자\n6. 이력 복원\n7. 정책 유효기간 갱신\n0. 종료')
  choice=input('선택: ').strip()
  if choice=='0':return
  try:
   state=api('/admin/state');policy=copy.deepcopy(state.get('policy') or defaults());access=copy.deepcopy(state['access'])
   if not state.get('policy'):access={'mode':'allowlist','users':[]}
   if choice=='1':
    print(json.dumps(state,ensure_ascii=False,indent=2))
    if state.get('policy'):print('정책 만료까지:',max(0,round((policy['expiresAt']/1000-time.time())/86400,1)),'일 (7번으로 갱신)')
    continue
   if choice=='2':
    add_release(policy)
    if not state.get('policy'):
     mode=input('최초 접근 모드 all(기존 이용자 포함) / allowlist(테스터만, 기본): ').strip() or 'allowlist'
     if mode not in ('all','allowlist'):raise ValueError('all 또는 allowlist를 입력하세요.')
     access['mode']=mode;configure_legacy(policy)
   elif choice=='3':
    policy['minimum']=input('최소 지원 버전: ').strip();policy['blocked']=[x.strip() for x in input('차단 버전 (쉼표 구분, 없으면 Enter): ').split(',') if x.strip()]
    policy['scope']=input('제한 범위 none(권장 업데이트) / discord / all: ').strip();policy['message']=input('사용자 안내: ').strip()
    configure_legacy(policy)
   elif choice=='4':
    print(FEATURES);name=input('설정할 기능: ').strip()
    if name not in FEATURES:raise ValueError('기능 이름을 확인하세요.')
    setting=input('사용 / 점검: ').strip()
    if setting not in ('사용','점검'):raise ValueError('사용 또는 점검을 입력하세요.')
    policy['features'][name]={'enabled':setting=='사용','reason':input('안내 문구: ').strip() if setting=='점검' else ''}
   elif choice=='5':
    print('현재:',json.dumps(access,ensure_ascii=False));mode=input('운영 모드 all / allowlist / maintenance (유지 Enter): ').strip()
    if mode:access['mode']=mode
    action=input('추가 / 제거 / 유지: ').strip()
    if action in ('추가','제거'):
     uid=input('디스코드 사용자 ID: ').strip()
     if not re.fullmatch(r'\d{17,22}',uid):raise ValueError('사용자 ID 형식을 확인하세요.')
     access['users']=[u for u in access['users'] if u['id']!=uid]
     if action=='추가':access['users'].append({'id':uid,'note':input('관리용 메모: ').strip()})
    elif action!='유지':raise ValueError('작업을 확인하세요.')
   elif choice=='6':
    history=api('/admin/history')
    for h in history:print(h['revision'],h['changedAt'],json.loads(h['envelope']['payload'])['latest'],h['access']['mode'])
    target=int(input('복원할 번호: '));record=next(h for h in history if h['revision']==target)
    releases=policy['releases'];policy=logical_policy(json.loads(record['envelope']['payload']));policy['releases']={**releases,**policy['releases']};access=record['access']
   elif choice=='7':pass
   else:continue
   publish(state,policy,access)
  except Exception as e:print('처리하지 못했습니다:',str(e))

def backup(restore=False):
 from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
 from cryptography.hazmat.primitives.ciphers.aead import AESGCM
 path=Path(input('암호화 백업 파일 경로: ').strip().strip('"'));password=getpass.getpass('백업 암호 (12자 이상): ')
 if len(password)<12:raise ValueError('12자 이상 입력하세요.')
 if restore:
  if (ADMIN_DIR/'credentials.dat').exists():raise ValueError('기존 관리자 키가 있습니다. 새 Windows 계정에서 복원하세요.')
  data=path.read_bytes();salt,nonce=data[:16],data[16:28]
 else:
  if password!=getpass.getpass('암호 다시 입력: '):raise ValueError('암호가 다릅니다.')
  if path.exists():raise ValueError('다른 백업 파일 이름을 사용하세요.')
  salt,nonce=os.urandom(16),os.urandom(12)
 key=Scrypt(salt=salt,length=32,n=2**15,r=8,p=1).derive(password.encode())
 if restore:
  raw=AESGCM(key).decrypt(nonce,data[28:],b'ErinnDeskAdmin1');json.loads(raw);ADMIN_DIR.mkdir(parents=True,exist_ok=True);(ADMIN_DIR/'credentials.dat').write_bytes(protect(raw));print('복원 완료.')
 else:path.write_bytes(salt+nonce+AESGCM(key).encrypt(nonce,json.dumps(credentials()).encode(),b'ErinnDeskAdmin1'));print('암호화 백업 완료. 암호와 백업 파일을 분리 보관하세요.')

if __name__=='__main__':
 try:
  action=sys.argv[1] if len(sys.argv)>1 else 'menu'
  {'init':initialize,'provision':provision,'menu':menu,'backup':backup,'restore':lambda:backup(True)}[action]()
 except Exception as e:print('관리 작업 실패:',str(e));sys.exit(1)
