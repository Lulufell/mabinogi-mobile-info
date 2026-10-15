"""Loopback-only operations UI. Signing credentials never enter the browser."""
import argparse, copy, hashlib, json, re, secrets, threading, time, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError
import operations as ops

ASSETS=Path(__file__).resolve().parent/'admin-ui'
VERSION=re.compile(r'\d{1,5}\.\d{1,5}\.\d{1,5}\Z')
MAX_UPLOAD=512*1024*1024

def https(value):
 if not isinstance(value,str) or len(value)>2048:raise ValueError('다운로드 주소를 확인하세요.')
 u=urlsplit(value)
 if u.scheme!='https' or not u.hostname or u.username or u.password or u.fragment:raise ValueError('인증정보 없는 HTTPS 다운로드 주소를 입력하세요.')
 return value

def validate(policy,access,now):
 for key in ('latest','minimum'):
  if not isinstance(policy.get(key),str) or not VERSION.fullmatch(policy[key]):raise ValueError('최신/최소 지원 버전 형식을 확인하세요.')
 if tuple(map(int,policy['minimum'].split('.')))>tuple(map(int,policy['latest'].split('.'))):raise ValueError('최소 지원 버전이 최신 버전보다 높습니다.')
 if policy.get('scope') not in ('discord','all'):raise ValueError('제한 범위를 확인하세요.')
 if not isinstance(policy.get('blocked'),list) or len(policy['blocked'])>100 or any(not isinstance(v,str) or not VERSION.fullmatch(v) for v in policy['blocked']):raise ValueError('차단 버전 형식을 확인하세요.')
 if not isinstance(policy.get('message'),str) or len(policy['message'])>500:raise ValueError('업데이트 안내는 500자 이내로 입력하세요.')
 deadline=policy.get('legacyUntil',0)
 if type(deadline) is not int or not 0<=deadline<=now+30*86400000:raise ValueError('구버전 유예 종료는 정책 유효기간 이내로 지정하세요.')
 if not isinstance(policy.get('features'),dict):raise ValueError('기능 설정을 확인하세요.')
 for name in ops.FEATURES:
  f=policy['features'].get(name,{})
  if not isinstance(f,dict):raise ValueError('기능 설정을 확인하세요.')
  if type(f.get('enabled')) is not bool or not isinstance(f.get('reason'),str) or len(f['reason'])>300:raise ValueError('기능 설정과 점검 안내를 확인하세요.')
 releases=policy.get('releases')
 if not isinstance(releases,dict) or len(releases)>500 or policy['latest'] not in releases:raise ValueError('최신 버전의 EXE를 먼저 검증해 등록하세요.')
 for version,r in releases.items():
  if not VERSION.fullmatch(version) or not isinstance(r,dict) or not re.fullmatch('[a-f0-9]{64}',str(r.get('sha256',''))) or type(r.get('size')) is not int or r['size']<1:raise ValueError('배포 파일 정보를 확인하세요.')
  https(r.get('url'))
 if not isinstance(access,dict) or access.get('mode') not in ('all','allowlist','maintenance') or not isinstance(access.get('users'),list) or len(access['users'])>10000:raise ValueError('접근 모드를 확인하세요.')
 seen=set()
 for user in access['users']:
  if not isinstance(user,dict) or not isinstance(user.get('id'),str) or not re.fullmatch(r'\d{17,22}',user['id']) or user['id'] in seen or not isinstance(user.get('note'),str) or len(user['note'])>100:raise ValueError('사용자 ID는 중복 없이 입력하고 메모는 100자 이내로 작성하세요.')
  seen.add(user['id'])

def download_matches(url,digest,size):
 class Redirect(HTTPRedirectHandler):
  def redirect_request(self,req,fp,code,msg,headers,newurl):
   https(newurl);return super().redirect_request(req,fp,code,msg,headers,newurl)
 started=time.monotonic();total=0;remote=hashlib.sha256()
 with build_opener(Redirect).open(Request(https(url),headers={'User-Agent':'ErinnDeskAdmin/1.0'}),timeout=20) as r:
  https(r.url)
  while chunk:=r.read(1024*1024):
   total+=len(chunk)
   if total>size or time.monotonic()-started>90:raise ValueError('다운로드 크기 또는 검증 시간을 초과했습니다.')
   remote.update(chunk)
 if total!=size or remote.hexdigest()!=digest:raise ValueError('게시된 파일이 선택한 EXE와 다릅니다. 다운로드 파일을 확인하세요.')

class Application:
 def __init__(self,api=None,sign=None,health=None,downloader=None):
  self.api=api or ops.api;self.sign=sign or ops.seal;self.health=health or self.get_health;self.downloader=downloader or download_matches
  self.token=secrets.token_urlsafe(32);self.lock=threading.Lock();self.plans={};self.verified=set()
 def get_health(self):
  class NoRedirect(HTTPRedirectHandler):
   def redirect_request(self,*args,**kwargs):return None
  with build_opener(NoRedirect).open(Request(ops.ENDPOINT+'/health',headers={'Accept':'application/json','User-Agent':'ErinnDeskAdmin/1.0'}),timeout=8) as r:return json.load(r)
 def state(self):
  health={};errors=[];state=None
  try:health=self.health()
  except HTTPError as e:errors.append(f'서버 상태 조회가 거절되었습니다 (HTTP {e.code}). 서버 접근 설정을 확인하세요.')
  except Exception:errors.append('서버 상태를 확인하지 못했습니다. 인터넷 연결을 확인하세요.')
  try:
   raw=self.api('/admin/state');state={k:raw.get(k) for k in ('revision','policy','access','changedAt')}
  except ValueError as e:
   message=str(e)
   if '(HTTP 404)' in message:errors.append('서버에 운영 관리 API가 없습니다. 최신 서버 코드를 배포해주세요. (HTTP 404)')
   elif '(HTTP 401)' in message:errors.append('관리자 인증정보가 서버와 일치하지 않습니다. 관리자 Secret 등록을 확인하세요. (HTTP 401)')
   elif '(HTTP 503)' in message:errors.append('서버 관리자 인증 설정이 필요합니다. 관리자 Secret 등록을 확인하세요. (HTTP 503)')
   else:errors.append('운영 설정을 불러오지 못했습니다. 서버 배포와 관리자 인증정보 등록을 확인하세요.')
  except Exception:errors.append('운영 설정을 불러오지 못했습니다. 서버 배포와 관리자 인증정보 등록을 확인하세요.')
  return {'state':state,'health':health,'errors':errors,'endpoint':ops.ENDPOINT,'keyReady':(ops.ADMIN_DIR/'credentials.dat').is_file()}
 def verify_release(self,version,url,digest,size):
  if not VERSION.fullmatch(version):raise ValueError('버전 형식은 1.4.9처럼 입력하세요.')
  https(url);self.downloader(url,digest,size)
  release={'sha256':digest,'size':size,'url':url}
  with self.lock:self.verified.add((version,digest,size,url))
  return {'version':version,'release':release}
 def prepare(self,body,restore=False):
  state=self.api('/admin/state')
  if type(body.get('expectedRevision')) is not int or body['expectedRevision']!=state['revision']:raise ValueError('서버 설정이 변경되었습니다. 새로고침 후 다시 확인하세요.')
  if restore:
   if type(body.get('revision')) is not int:raise ValueError('복원할 이력을 선택하세요.')
   record=next((h for h in self.api('/admin/history') if h['revision']==body['revision']),None)
   if not record:raise ValueError('복원할 이력이 없습니다.')
   policy=json.loads(record['envelope']['payload']);access=record['access']
   policy['releases']={**(state.get('policy') or {}).get('releases',{}),**policy['releases']}
  else:policy=copy.deepcopy(body.get('policy'));access=copy.deepcopy(body.get('access'))
  if not isinstance(policy,dict):raise ValueError('운영 설정을 확인하세요.')
  # Only supported fields can be signed by this local UI.
  policy={k:policy[k] for k in ('latest','minimum','scope','blocked','legacyUntil','message','features','releases') if k in policy}
  now=int(time.time()*1000);policy.update(schema=1,revision=state['revision']+1,issuedAt=now,expiresAt=now+30*86400000)
  validate(policy,access,now)
  if not restore:
   old=(state.get('policy') or {}).get('releases',{})
   with self.lock:
    for v,r in policy['releases'].items():
     if old.get(v)!=r and (v,r['sha256'],r['size'],r['url']) not in self.verified:raise ValueError('추가·변경한 EXE 파일을 먼저 검증하세요.')
   for v,r in old.items():
    if v in policy['releases'] and (r['sha256']!=policy['releases'][v]['sha256'] or r['size']!=policy['releases'][v]['size']):raise ValueError('기존 버전의 EXE는 교체할 수 없습니다. 새 버전을 사용하세요.')
  ticket=secrets.token_urlsafe(24)
  with self.lock:
   self.plans={k:v for k,v in self.plans.items() if v['until']>time.time()}
   if len(self.plans)>=32:raise ValueError('열려 있는 적용 확인이 많습니다. 잠시 후 다시 시도하세요.')
   self.plans[ticket]={'expectedRevision':state['revision'],'policy':policy,'access':access,'until':time.time()+180}
  return {'ticket':ticket,'before':{'policy':state.get('policy'),'access':state.get('access')},'after':{'policy':policy,'access':access}}
 def commit(self,ticket):
  if not isinstance(ticket,str):raise ValueError('적용 내용을 다시 확인하세요.')
  with self.lock:plan=self.plans.pop(ticket,None)
  if not plan or plan['until']<=time.time():raise ValueError('적용 확인이 만료되었습니다. 변경 내용을 다시 확인하세요.')
  # Consume before network I/O: uncertain responses must never cause blind resubmission.
  return self.api('/admin/state',{'expectedRevision':plan['expectedRevision'],'envelope':self.sign(plan['policy']),'access':plan['access']})
 def history(self):
  return [{'revision':r['revision'],'changedAt':r['changedAt'],'policy':json.loads(r['envelope']['payload']),'access':r['access']} for r in self.api('/admin/history')]

class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def reply(self,status,body,mime='application/json; charset=utf-8'):
  data=body if isinstance(body,bytes) else json.dumps(body,ensure_ascii=False).encode()
  self.send_response(status)
  for k,v in {'Content-Type':mime,'Content-Length':str(len(data)),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"}.items():self.send_header(k,v)
  self.end_headers();self.wfile.write(data)
 def authorized(self,api=False):
  origin=f'http://127.0.0.1:{self.server.server_port}'
  if self.headers.get('Host')!=origin.split('//')[1] or self.headers.get('Origin') not in (None,origin):self.reply(403,{'error':'이 PC의 관리 페이지에서만 사용할 수 있습니다.'});return False
  if api and not secrets.compare_digest(self.headers.get('X-Erinn-Admin',''),self.server.app.token):self.reply(403,{'error':'관리 페이지를 다시 열어주세요.'});return False
  return True
 def do_GET(self):
  path=urlsplit(self.path).path
  if not self.authorized(path.startswith('/api/')):return
  if path=='/':
   html=(ASSETS/'index.html').read_text(encoding='utf-8')
   return self.reply(200,html.encode(),'text/html; charset=utf-8')
  if path in ('/admin.js','/admin.css'):
   return self.reply(200,(ASSETS/path[1:]).read_bytes(),'text/javascript; charset=utf-8' if path.endswith('.js') else 'text/css; charset=utf-8')
  try:
   if path=='/api/state':return self.reply(200,self.server.app.state())
   if path=='/api/history':return self.reply(200,self.server.app.history())
   self.reply(404,{'error':'페이지가 없습니다.'})
  except Exception:self.reply(502,{'error':'서버에서 정보를 가져오지 못했습니다. 연결과 관리자 설정을 확인하세요.'})
 def do_POST(self):
  if not self.authorized(True):return
  try:
   self.connection.settimeout(120)
   if self.headers.get('Transfer-Encoding'):raise ValueError('요청 형식을 확인하세요.')
   length=int(self.headers.get('Content-Length',0));path=urlsplit(self.path).path
   if path=='/api/release':
    if not 0<length<=MAX_UPLOAD:raise ValueError('EXE 파일은 512MB 이하로 선택하세요.')
    params=parse_qs(urlsplit(self.path).query);version=params.get('version',[''])[0];url=params.get('url',[''])[0]
    if not VERSION.fullmatch(version):raise ValueError('버전 형식을 확인하세요.')
    https(url);digest=hashlib.sha256();remaining=length
    while remaining:
     chunk=self.rfile.read(min(1024*1024,remaining))
     if not chunk:raise ValueError('EXE 파일 전송이 중단되었습니다.')
     digest.update(chunk);remaining-=len(chunk)
    return self.reply(200,self.server.app.verify_release(version,url,digest.hexdigest(),length))
   if not 0<length<=262144 or self.headers.get('Content-Type','').split(';')[0]!='application/json':raise ValueError('설정 형식을 확인하세요.')
   body=json.loads(self.rfile.read(length))
   if not isinstance(body,dict):raise ValueError('설정 형식을 확인하세요.')
   if path in ('/api/prepare','/api/restore'):return self.reply(200,self.server.app.prepare(body,path=='/api/restore'))
   if path=='/api/commit':return self.reply(200,self.server.app.commit(body.get('ticket')))
   self.reply(404,{'error':'지원하지 않는 작업입니다.'})
  except ValueError as e:self.reply(400,{'error':str(e)[:500]})
  except Exception:self.reply(502,{'error':'처리 결과를 확인하지 못했습니다. 다시 적용하기 전에 새로고침으로 서버 상태를 확인하세요.'})

def create_server(port=0,app=None):
 server=ThreadingHTTPServer(('127.0.0.1',port),Handler);server.app=app or Application();return server

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=0);parser.add_argument('--no-browser',action='store_true');args=parser.parse_args()
 server=create_server(args.port);url=f'http://127.0.0.1:{server.server_port}/#session={server.app.token}'
 print('Erinn Desk 관리 페이지:',url);print('종료하려면 이 창에서 Ctrl+C를 누르세요.')
 if not args.no_browser:webbrowser.open(url)
 try:server.serve_forever()
 except KeyboardInterrupt:pass
 finally:server.server_close()

if __name__=='__main__':main()
