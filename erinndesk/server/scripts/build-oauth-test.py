"""Build an isolated OAuth test EXE without changing the release source version."""
import argparse,hashlib,shutil,subprocess,sys,json
from datetime import datetime,timezone
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--stage',type=Path,required=True);args=p.parse_args()
source=args.source.resolve();stage=args.stage.resolve();output=args.output.resolve()
if stage==source or source in stage.parents and stage.name!='oauth-test-source':raise SystemExit('Use a dedicated oauth-test-source staging directory.')
web=stage/'outputs/erinn-web';shutil.copytree(source/'outputs/erinn-web',web,dirs_exist_ok=True,ignore=shutil.ignore_patterns('__pycache__','*.zip'))
work=stage/'work';work.mkdir(parents=True,exist_ok=True)
shutil.copy2(source/'work/ErinnDeskDesktop.spec',work/'ErinnDeskDesktop.spec')
build_id='dev-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
(web/'bridge/oauth_build_profile.py').write_text('OAUTH_TEST = True\nBUILD_ID = '+repr(build_id)+'\n',encoding='utf-8')
p=web/'bridge/desk.py';s=p.read_text(encoding='utf-8').replace("VERSION = '1.4.9'","VERSION = '1.5.1'").replace("/ 'ErinnDesk' / 'settings.json'","/ 'ErinnDesk-OAuthTest' / 'settings.json'");p.write_text(s,encoding='utf-8')
p=web/'bridge/desktop.py';s=p.read_text(encoding='utf-8').replace("/ 'ErinnDesk'","/ 'ErinnDesk-OAuthTest'").replace('ErinnDeskDirectPortable-2','ErinnDeskOAuthTest-1').replace("create_window('Erinn Desk'","create_window('Erinn Desk · 개발 빌드'").replace('content="local151"','content="'+build_id+'"');p.write_text(s,encoding='utf-8')
p=web/'bridge/portable.py';s=p.read_text(encoding='utf-8').replace('local151',build_id);p.write_text(s,encoding='utf-8')
p=web/'site/index.html';s=p.read_text(encoding='utf-8').replace('local151',build_id).replace('v1.5.1','v1.5.1 · 개발 빌드');p.write_text(s,encoding='utf-8')

subprocess.run([sys.executable,'-m','PyInstaller','--noconfirm','--clean','--distpath',str(output),'--workpath',str(stage/'pyinstaller'),'ErinnDeskDesktop.spec'],cwd=work,check=True)
exe=output/'ErinnDesk.exe';digest=hashlib.sha256(exe.read_bytes()).hexdigest();(output/'SHA256.txt').write_text(digest+'  ErinnDesk.exe\n',encoding='utf-8');(output/'build-info.json').write_text(json.dumps({'version':'1.5.1','channel':'development','buildId':build_id,'sha256':digest},indent=2),encoding='utf-8');print(str(exe));print(digest)
