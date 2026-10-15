"""Windows local-workerd smoke test. Isolated storage and synthetic keys only."""
import base64,json,os,socket,subprocess,tempfile,time
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding,PublicFormat

root=Path(__file__).resolve().parent.parent
node=Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
key=Ed25519PrivateKey.generate();public=key.public_key().public_bytes(Encoding.Raw,PublicFormat.Raw).hex()
with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
url=f'http://127.0.0.1:{port}';token='local-runtime-fixture-token-'+'x'*32
def call(path,body=None,method=None,auth=False,version=None):
 headers={'Content-Type':'application/json'}
 if auth:headers['Authorization']='Bearer '+token
 if version:headers['X-Erinn-Version']=version
 req=Request(url+path,data=json.dumps(body).encode() if body is not None else None,method=method,headers=headers)
 try:
  with urlopen(req,timeout=10) as r:return r.status,json.load(r)
 except HTTPError as e:return e.code,json.load(e)

with tempfile.TemporaryDirectory(prefix='erinndesk-ops-runtime-',ignore_cleanup_errors=True) as folder:
 with (Path(folder)/'runtime.log').open('w+',encoding='utf-8') as log:
  args=[str(node) if node.exists() else 'node',str(root/'node_modules/wrangler/bin/wrangler.js'),'dev','--local','--ip','127.0.0.1','--port',str(port),'--persist-to',str(Path(folder)/'storage'),'--var','LOCAL_TEST:true','--var','OPS_PUBLIC_KEY:'+public,'--var','OPS_ADMIN_TOKEN:'+token]
  p=subprocess.Popen(args,cwd=root,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW,env={**os.environ,'WRANGLER_SEND_METRICS':'false'})
  try:
   for _ in range(60):
    try:
     if call('/health')[0]==200:break
    except Exception:pass
    if p.poll() is not None:raise RuntimeError('local workerd startup failed')
    time.sleep(.25)
   else:raise RuntimeError('local workerd timeout')
   assert call('/admin/state')[0]==401
   assert call('/policy')[0]==503
   assert call('/admin/state',auth=True)[1]['revision']==0
   now=int(time.time()*1000)
   policy={'schema':1,'revision':1,'issuedAt':now,'expiresAt':now+86400000,'latest':'1.4.9','minimum':'1.4.9','scope':'discord','blocked':[],'message':'Update required','features':{k:{'enabled':True,'reason':''} for k in ['discord','link','items','capture']},'releases':{'1.4.9':{'sha256':'a'*64,'size':100,'url':'https://example.com/ErinnDesk.exe'}}}
   def publish():
    payload=json.dumps(policy);envelope={'payload':payload,'signature':base64.b64encode(key.sign(payload.encode())).decode()}
    return call('/admin/state',{'expectedRevision':policy['revision']-1,'envelope':envelope,'access':{'mode':'allowlist','users':[{'id':'123456789012345678','note':'private fixture'}]}},'PUT',True)
   assert publish()[0]==200
   assert 'private fixture' not in json.dumps(call('/policy')[1])
   assert call('/register',{},'POST',version='1.4.8')[0]==403
   assert call('/register',{},'POST',version='1.4.9')[0]==200
   policy['revision']=2;policy['features']['link']={'enabled':False,'reason':'Maintenance fixture'}
   assert publish()[0]==200
   assert call('/register',{},'POST',version='1.4.9')[0]==403
   assert len(call('/admin/history',auth=True)[1])==1
   policy['revision']=3;policy['features']['link']={'enabled':True,'reason':''};policy['legacyUntil']=int(time.time()*1000)+60000
   assert publish()[0]==200
   assert call('/register',{},'POST')[0]==200
   assert call('/register',{},'POST',version='1.4.8')[0]==403
   policy['revision']=4;policy['legacyUntil']=int(time.time()*1000)-1
   assert publish()[0]==200
   assert call('/register',{},'POST')[0]==403
   print('PASS local workerd: admin auth, real Ed25519 signature, private allowlist, transactional publication/history, version/link restriction')
  except Exception:
   log.flush();log.seek(0);print(log.read()[-5000:]);raise
  finally:
   subprocess.run(['taskkill','/PID',str(p.pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);p.wait(timeout=10)
