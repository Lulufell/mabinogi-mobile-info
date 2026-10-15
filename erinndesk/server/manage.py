"""Developer setup only. Bot token is read secretly and never saved."""
import getpass,json,re,sys,os
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError
ROOT=Path(__file__).resolve().parent

def registration_error(exc,token):
 """Show Discord validation details without credentials or request headers."""
 details=[]
 raw=b''
 try:
  raw=exc.read(16384)
  encoding=exc.headers.get('Content-Encoding','').lower() if exc.headers else ''
  if encoding=='gzip':
   import gzip
   raw=gzip.decompress(raw)
  elif encoding=='deflate':
   import zlib
   raw=zlib.decompress(raw)
  body=json.loads(raw)
  if isinstance(body,dict):
   if isinstance(body.get('code'),int):details.append('Discord code: '+str(body['code']))
   if isinstance(body.get('message'),str):details.append(body['message'])
   def visit(value,path=''):
    if not isinstance(value,dict):return
    for error in value.get('_errors',[]):
     if isinstance(error,dict):details.append(path+': '+str(error.get('code',''))+' '+str(error.get('message','')))
    for key,value in value.items():
     if key!='_errors':visit(value,(path+'.' if path else '')+key)
   visit(body.get('errors',{}))
 except Exception:pass
 if not details:
  content_type=exc.headers.get('Content-Type','알 수 없음') if exc.headers else '알 수 없음'
  details.append('응답 형식: '+content_type+' / '+str(len(raw))+' bytes')
  snippet=raw.decode('utf-8',errors='replace')
  if token:snippet=snippet.replace(token,'[숨김]')
  snippet=re.sub(r'<[^>]*>',' ',snippet)
  snippet=' '.join(snippet.split())[:600]
  if snippet:details.append('응답 내용: '+snippet)
 text='\n'.join(details)
 if token:text=text.replace(token,'[숨김]')
 text=text[:4000]
 if token:text=text.replace(token,'[숨김]')
 text=''.join(c for c in text if c in '\n\t' or ord(c)>=32)
 return f'명령 등록 실패 (HTTP {exc.code}).'+ ('\n'+text if text else '\nDiscord에서 상세 오류를 받지 못했습니다.')

COMMANDS=[
 {'name':'연결','description':'에린 데스크의 일회용 코드로 내 PC를 연결합니다.','options':[{'type':3,'name':'코드','description':'PC에서 생성한 연결 코드','required':True,'min_length':10,'max_length':10}]},
 {'name':'아이템','description':'연결된 PC에서 아이템의 가방·창고 수량을 조회합니다.','options':[{'type':3,'name':'이름','description':'조회할 품목 이름 또는 검색어','required':True,'min_length':1,'max_length':120}]},
 {'name':'연결상태','description':'내 PC의 원격 연결 상태를 확인합니다.'},
 {'name':'스크린샷','description':'연결된 PC의 게임 창을 캡처합니다. PC에서 허용 필요 · 10분에 1회.'},
 {'name':'연결해제','description':'내 디스코드 계정과 PC의 연결을 해제합니다.'}
]

def configure():
 config=json.loads((ROOT/'wrangler.jsonc').read_text(encoding='utf-8'))
 for key,label,pattern in [('DISCORD_APPLICATION_ID','디스코드 Application ID',r'\d{17,22}'),('DISCORD_PUBLIC_KEY','디스코드 Public Key',r'[a-fA-F0-9]{64}'),('DISCORD_GUILD_ID','전용 디스코드 서버 ID',r'\d{17,22}')]:
  value=input(label+': ').strip()
  if not re.fullmatch(pattern,value):raise ValueError(label+' 형식을 확인하세요.')
  config['vars'][key]=value
 (ROOT/'wrangler.jsonc').write_text(json.dumps(config,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
 print('설정 저장 완료. 다음으로 Cloudflare 로그인과 배포를 진행하세요.')

def registration_token():
 token=os.environ.get('DISCORD_BOT_TOKEN','').strip()
 if not token:
  if os.environ.get('CI') or not sys.stdin.isatty():
   raise ValueError('DISCORD_BOT_TOKEN Secret이 없습니다. GitHub erinn-production 환경에 등록하세요.')
  token=getpass.getpass('디스코드 Bot Token (화면에 표시·파일 저장하지 않음): ').strip()
 return token

def register():
 config=json.loads((ROOT/'wrangler.jsonc').read_text(encoding='utf-8'))['vars']
 if not config['DISCORD_APPLICATION_ID'].isdigit() or not config['DISCORD_GUILD_ID'].isdigit():raise ValueError('먼저 configure를 실행하세요.')
 token=registration_token()
 if token.startswith('Bot '):token=token[4:].strip()
 if not token or not re.fullmatch(r'[A-Za-z0-9_.-]+',token):
  raise ValueError('토큰 입력에 공백·제어문자 또는 잘못된 문자가 있습니다. Bot 화면에서 토큰을 다시 복사하고 터미널의 우클릭 또는 Ctrl+Shift+V로 붙여넣으세요. 토큰은 채팅에 보내지 마세요.')
 headers={'Authorization':'Bot '+token,'Content-Type':'application/json','Accept':'application/json','Accept-Encoding':'identity','User-Agent':'DiscordBot (https://github.com/lulufell/mabinogi-mobile-info, 1.0)'}
 # A read-only check separates token/header failures from command validation.
 try:
  with urlopen(Request('https://discord.com/api/v10/users/@me',headers=headers),timeout=20) as response:identity=json.load(response)
 except HTTPError as exc:raise ValueError('봇 인증 확인 단계에서 실패했습니다.\n'+registration_error(exc,token)) from None
 if not identity.get('bot'):raise ValueError('Bot Token이 아닙니다. 개발자 포털의 Bot 화면에서 발급한 토큰을 사용하세요.')
 if str(identity.get('id'))!=config['DISCORD_APPLICATION_ID']:raise ValueError('입력한 토큰의 봇과 설정된 Application ID가 다릅니다. 같은 앱의 ID와 Bot Token을 사용하세요.')
 print('봇 인증 확인 완료. 서버 명령을 등록합니다.')
 url=f"https://discord.com/api/v10/applications/{config['DISCORD_APPLICATION_ID']}/guilds/{config['DISCORD_GUILD_ID']}/commands"
 request=Request(url,data=json.dumps(COMMANDS,ensure_ascii=True).encode('ascii'),method='PUT',headers=headers)
 try:
  with urlopen(request,timeout=20) as response:commands=json.load(response)
 except HTTPError as exc:raise ValueError(registration_error(exc,token)) from None
 print('등록 완료:',', '.join(c['name'] for c in commands))

def endpoint():
 from urllib.parse import urlsplit
 url=input('배포된 Worker 기본 주소 (https://...workers.dev): ').strip().rstrip('/')
 parsed=urlsplit(url)
 if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path or parsed.port not in (None,443):raise ValueError('HTTPS 기본 주소를 입력하세요.')
 try:
  request=Request(url+'/health',headers={'User-Agent':'ErinnDeskSetup/1.0','Accept':'application/json'})
  with urlopen(request,timeout=10) as response:data=json.load(response)
 except HTTPError as exc:raise ValueError(f'서비스 확인 실패 (HTTP {exc.code}). 배포 상태와 Cloudflare 접근 차단 설정을 확인하세요.') from None
 except Exception:raise ValueError('서비스에 접속하지 못했습니다. 배포와 주소를 확인하세요.') from None
 if data.get('service')!='Erinn Desk Remote':raise ValueError('에린 데스크 원격 서비스가 아닙니다.')
 # Source builds receive this public endpoint; existing EXEs can use adjacent JSON.
 source=ROOT.parent/'erinn-web'/'site'/'remote-service.json'
 content=json.dumps({'url':url},ensure_ascii=False)+'\n'
 if source.parent.is_dir():source.write_text(content,encoding='utf-8')
 (ROOT/'remote-service.json').write_text(content,encoding='utf-8')
 print('서비스 주소 저장 완료:',url)
 print('Discord Interactions Endpoint URL:',url+'/discord')
 print('기존 EXE 배포 시 이 폴더의 remote-service.json을 EXE 옆에 함께 두세요.')

if __name__=='__main__':
 try:
  action=sys.argv[1] if len(sys.argv)>1 else input('configure / register / endpoint 중 입력: ').strip()
  {'configure':configure,'register':register,'endpoint':endpoint}[action]()
 except (ValueError,KeyError,OSError) as exc:print('설정 실패:',str(exc));sys.exit(1)
