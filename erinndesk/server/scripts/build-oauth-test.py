"""Build an isolated OAuth test EXE without changing the release source version."""
import argparse,hashlib,shutil,subprocess,sys
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--stage',type=Path,required=True);args=p.parse_args()
source=args.source.resolve();stage=args.stage.resolve();output=args.output.resolve()
if stage==source or source in stage.parents and stage.name!='oauth-test-source':raise SystemExit('Use a dedicated oauth-test-source staging directory.')
web=stage/'outputs/erinn-web';shutil.copytree(source/'outputs/erinn-web',web,dirs_exist_ok=True,ignore=shutil.ignore_patterns('__pycache__','*.zip'))
work=stage/'work';work.mkdir(parents=True,exist_ok=True)
shutil.copy2(source/'work/ErinnDeskDesktop.spec',work/'ErinnDeskDesktop.spec')
(web/'bridge/oauth_build_profile.py').write_text('OAUTH_TEST = True\n',encoding='utf-8')
p=web/'bridge/desk.py';s=p.read_text(encoding='utf-8').replace("VERSION = '1.4.9'","VERSION = '1.5.1'").replace("/ 'ErinnDesk' / 'settings.json'","/ 'ErinnDesk-OAuthTest' / 'settings.json'");p.write_text(s,encoding='utf-8')
p=web/'bridge/desktop.py';s=p.read_text(encoding='utf-8').replace("/ 'ErinnDesk'","/ 'ErinnDesk-OAuthTest'").replace('ErinnDeskDirectPortable-2','ErinnDeskOAuthTest-1').replace("create_window('Erinn Desk'","create_window('Erinn Desk · OAuth 테스트'").replace('content="local149"','content="oauth-test-151"');p.write_text(s,encoding='utf-8')
p=web/'bridge/portable.py';s=p.read_text(encoding='utf-8').replace('local149','oauth-test-151');p.write_text(s,encoding='utf-8')
p=web/'site/index.html';s=p.read_text(encoding='utf-8').replace('local149','oauth-test-151').replace('v1.4.9','v1.5.1 · OAuth 테스트');p.write_text(s,encoding='utf-8')
p=web/'site/remote-ui.js';s=p.read_text(encoding='utf-8').replace('<h1>디스코드 연결</h1>','<h1>디스코드 연결 · OAuth 테스트</h1>').replace('게임과 에린 데스크를 켜두면','테스트 계정만 연결할 수 있으며 배포 파일 등록은 필요하지 않습니다. 게임과 에린 데스크를 켜두면');p.write_text(s,encoding='utf-8')
subprocess.run([sys.executable,'-m','PyInstaller','--noconfirm','--clean','--distpath',str(output),'--workpath',str(stage/'pyinstaller'),'ErinnDeskDesktop.spec'],cwd=work,check=True)
exe=output/'ErinnDesk.exe';digest=hashlib.sha256(exe.read_bytes()).hexdigest();(output/'SHA256.txt').write_text(digest+'  ErinnDesk.exe\n',encoding='utf-8');print(str(exe));print(digest)
