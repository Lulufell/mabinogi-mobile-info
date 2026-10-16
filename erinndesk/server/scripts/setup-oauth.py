"""Interactive secret provisioning. Never write the Discord Client Secret to disk."""
import getpass,re,shutil,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parent.parent
print('Discord Developer Portal > 해당 앱 > OAuth2 > Redirects에 다음 주소를 먼저 추가하세요:')
print('https://erinn-desk-remote.lulufell.workers.dev/oauth/callback')
users=input('테스트 허용 Discord 사용자 ID (여러 명은 쉼표 구분): ').strip()
ids=[v.strip() for v in users.split(',')]
if not ids or any(not re.fullmatch(r'\d{17,22}',v) for v in ids):raise SystemExit('사용자 ID 형식을 확인하세요.')
secret=getpass.getpass('Discord OAuth2 Client Secret (Bot Token 아님, 화면에 표시되지 않음): ').strip()
if len(secret)<20:raise SystemExit('Client Secret을 확인하세요.')
node=shutil.which('node')
if not node:
 candidate=Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
 if candidate.exists():node=str(candidate)
if not node:raise SystemExit('Node.js를 설치하거나 PATH를 설정하세요.')
cli=root/'node_modules/wrangler/bin/wrangler.js'
if not cli.exists():raise SystemExit('서버 의존성을 먼저 설치하세요.')
for key,value in [('DISCORD_CLIENT_SECRET',secret),('OAUTH_TEST_USERS',','.join(dict.fromkeys(ids)))]:
 subprocess.run([node,str(cli),'secret','put',key],input=value+'\n',text=True,cwd=root,check=True)
print('서버 인증 설정을 등록했습니다. 서버 코드도 최신 버전으로 배포한 후 테스트 EXE로 연결하세요.')
