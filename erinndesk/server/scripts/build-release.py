"""Build the release EXE with all operations guards enabled."""
import argparse,hashlib,json,shutil,subprocess,sys
from datetime import datetime,timezone
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--stage',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
source=a.source.resolve();stage=a.stage.resolve();output=a.output.resolve()
if stage==source:raise SystemExit('Use a separate staging directory.')
web=stage/'outputs/erinn-web';work=stage/'work';work.mkdir(parents=True,exist_ok=True)
shutil.copytree(source/'outputs/erinn-web',web,dirs_exist_ok=True,ignore=shutil.ignore_patterns('__pycache__','*.zip'))
shutil.copy2(source/'work/ErinnDeskDesktop.spec',work/'ErinnDeskDesktop.spec')
build_id='release-1.5.1-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
(web/'bridge/oauth_build_profile.py').write_text('OAUTH_TEST = False\nBUILD_ID = '+repr(build_id)+'\n',encoding='utf-8')
assert "VERSION = '1.5.1'" in (web/'bridge/desk.py').read_text(encoding='utf-8')
for name in ['desktop.py','portable.py']:
 path=web/'bridge'/name;s=path.read_text(encoding='utf-8').replace('local151',build_id);path.write_text(s,encoding='utf-8')
subprocess.run([sys.executable,'-m','PyInstaller','--noconfirm','--clean','--distpath',str(output),'--workpath',str(stage/'pyinstaller'),'ErinnDeskDesktop.spec'],cwd=work,check=True)
exe=output/'ErinnDesk.exe';digest=hashlib.sha256(exe.read_bytes()).hexdigest();(output/'SHA256.txt').write_text(digest+'  ErinnDesk.exe\n',encoding='utf-8');(output/'build-info.json').write_text(json.dumps({'version':'1.5.1','channel':'release','buildId':build_id,'sha256':digest},indent=2),encoding='utf-8');print(str(exe));print(digest)
