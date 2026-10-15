import copy,hashlib,json,sys,threading,unittest,time
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from unittest.mock import Mock,patch,MagicMock
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
import admin_web as web
import operations as ops

class Fixture:
 def __init__(self):
  p=ops.defaults();p.update(revision=1,issuedAt=int(time.time()*1000),expiresAt=int(time.time()*1000)+86400000)
  p['releases']={'1.4.9':{'sha256':'a'*64,'size':10,'url':'https://example.com/app.exe'}}
  self.state={'revision':1,'policy':p,'access':{'mode':'all','users':[]},'changedAt':p['issuedAt'],'envelope':{'payload':'not-returned'}};self.writes=[]
 def api(self,path,body=None):
  if path=='/admin/history':return [{'revision':1,'changedAt':self.state['changedAt'],'envelope':{'payload':json.dumps(self.state['policy'])},'access':self.state['access']}]
  if body is None:return copy.deepcopy(self.state)
  if body['expectedRevision']!=self.state['revision']:raise ValueError('conflict')
  self.writes.append(body);self.state['revision']+=1;return {'ok':True,'revision':self.state['revision']}

class WebTests(unittest.TestCase):
 def setUp(self):
  self.fixture=Fixture();self.sign=Mock(return_value={'payload':'signed','signature':'test-signature'})
  self.download=Mock();self.app=web.Application(self.fixture.api,self.sign,lambda:{'ok':True,'commit':'fixture-commit'},self.download)
  self.server=web.create_server(app=self.app);self.url=f'http://127.0.0.1:{self.server.server_port}';threading.Thread(target=self.server.serve_forever,daemon=True).start()
 def tearDown(self):self.server.shutdown();self.server.server_close()
 def call(self,path,body=None,headers=None,auth=True,raw=False):
  h={'X-Erinn-Admin':self.app.token} if auth else {}
  if body is not None and not raw:h['Content-Type']='application/json'
  h.update(headers or {});data=body if raw else json.dumps(body).encode() if body is not None else None
  try:
   with urlopen(Request(self.url+path,data=data,headers=h),timeout=5) as r:return r.status,r.headers,r.read()
  except HTTPError as e:return e.code,e.headers,e.read()
 def body(self):return {'expectedRevision':1,'policy':copy.deepcopy(self.fixture.state['policy']),'access':{'mode':'all','users':[]}}
 def test_health_request_identifies_admin_client(self):
  with patch.object(web,'build_opener') as opener:
   response=opener.return_value.open.return_value.__enter__.return_value;response.read.return_value=b'{"ok":true}'
   self.assertTrue(web.Application().get_health()['ok'])
   req=opener.return_value.open.call_args.args[0];self.assertEqual(req.get_header('User-agent'),'ErinnDeskAdmin/1.0')
 def test_missing_management_api_is_distinguished_from_server_outage(self):
  self.app.api=Mock(side_effect=ValueError('운영 요청 실패 (HTTP 404): not_found'))
  state=self.app.state();self.assertTrue(state['health']['ok']);self.assertIn('최신 서버 코드를 배포',state['errors'][0])
 def test_host_origin_and_session_authentication(self):
  self.assertEqual(self.server.server_address[0],'127.0.0.1')
  self.assertEqual(self.call('/api/state',auth=False)[0],403)
  self.assertEqual(self.call('/',headers={'Host':'evil.example'})[0],403)
  self.assertEqual(self.call('/api/state',headers={'Origin':'https://evil.example'})[0],403)
  self.assertEqual(self.call('/api/prepare',self.body(),auth=False)[0],403)
  self.assertEqual(self.call('/api/prepare',self.body(),headers={'Origin':'null'})[0],403)
  status,headers,body=self.call('/');self.assertEqual(status,200);self.assertNotIn(self.app.token.encode(),body);self.assertEqual(headers['X-Frame-Options'],'DENY');self.assertIn("connect-src 'self'",headers['Content-Security-Policy'])
  self.assertEqual(self.call('/../operations.py')[0],404)
 def test_state_does_not_expose_envelope_credentials_or_signature(self):
  s=json.loads(self.call('/api/state')[2]);self.assertNotIn('envelope',s['state']);self.assertEqual(s['health']['commit'],'fixture-commit')
  for name in ('private','token','signature'):self.assertNotIn('"'+name+'"',json.dumps(s))
 def test_preview_is_read_only_commit_is_once_only_and_signed_locally(self):
  body=self.body();body['policy']['features']['capture']={'enabled':False,'reason':'점검'}
  status,_,raw=self.call('/api/prepare',body);self.assertEqual(status,200);plan=json.loads(raw)
  self.sign.assert_not_called();self.assertEqual(self.fixture.writes,[]);self.assertTrue(plan['before']['policy']['features']['capture']['enabled'])
  self.assertEqual(self.call('/api/commit',{'ticket':plan['ticket']})[0],200);self.sign.assert_called_once();self.assertEqual(len(self.fixture.writes),1)
  self.assertEqual(self.call('/api/commit',{'ticket':plan['ticket']})[0],400);self.assertEqual(len(self.fixture.writes),1)
 def test_stale_revision_expired_ticket_and_unverified_release_rejected(self):
  body=self.body();body['expectedRevision']=0;self.assertEqual(self.call('/api/prepare',body)[0],400)
  body=self.body();body['policy']['releases']['1.4.10']=body['policy']['releases']['1.4.9'];self.assertEqual(self.call('/api/prepare',body)[0],400)
  plan=json.loads(self.call('/api/prepare',self.body())[2]);self.app.plans[plan['ticket']]['until']=0
  self.assertEqual(self.call('/api/commit',{'ticket':plan['ticket']})[0],400);self.assertEqual(self.fixture.writes,[])
 def test_verified_upload_hashes_without_saving_or_executing_and_allows_preview(self):
  data=b'fake EXE fixture';url='https://example.com/new.exe'
  status,_,raw=self.call('/api/release?version=1.4.10&url='+url,data,raw=True);self.assertEqual(status,200);release=json.loads(raw)['release']
  self.download.assert_called_once_with(url,hashlib.sha256(data).hexdigest(),len(data))
  body=self.body();body['policy']['latest']='1.4.10';body['policy']['releases']['1.4.10']=release
  self.assertEqual(self.call('/api/prepare',body)[0],200);self.assertEqual(self.fixture.writes,[])
 def test_url_change_revalidates_registered_hash_and_stages_without_changing_latest(self):
  url='https://example.com/moved.exe'
  status,_,raw=self.call('/api/release-url',{'version':'1.4.9','url':url});self.assertEqual(status,200)
  self.download.assert_called_once_with(url,'a'*64,10)
  body=self.body();body['policy']['releases']['1.4.9']=json.loads(raw)['release']
  status,_,plan=self.call('/api/prepare',body);self.assertEqual(status,200);self.assertEqual(json.loads(plan)['after']['policy']['latest'],'1.4.9');self.assertEqual(self.fixture.writes,[])
 def test_url_change_rejects_unknown_version_and_failed_verification(self):
  self.assertEqual(self.call('/api/release-url',{'version':'1.4.10','url':'https://example.com/new.exe'})[0],400);self.download.assert_not_called()
  self.download.side_effect=ValueError('게시된 파일이 다릅니다.')
  self.assertEqual(self.call('/api/release-url',{'version':'1.4.9','url':'https://example.com/new.exe'})[0],400)
  self.assertEqual(self.fixture.writes,[]);self.assertEqual(self.app.verified,set())
 def test_restore_is_previewed_and_preserves_newer_release_records(self):
  self.fixture.state['policy']['releases']['1.4.10']={'sha256':'b'*64,'size':20,'url':'https://example.com/b.exe'}
  status,_,raw=self.call('/api/restore',{'expectedRevision':1,'revision':1});self.assertEqual(status,200)
  self.assertIn('1.4.10',json.loads(raw)['after']['policy']['releases']);self.assertEqual(self.fixture.writes,[])
 def test_network_uncertainty_consumes_ticket_without_automatic_retry(self):
  plan=json.loads(self.call('/api/prepare',self.body())[2]);original=self.app.api
  self.app.api=Mock(side_effect=OSError('timeout'))
  self.assertEqual(self.call('/api/commit',{'ticket':plan['ticket']})[0],502);self.assertEqual(self.call('/api/commit',{'ticket':plan['ticket']})[0],400);self.app.api.assert_called_once();self.app.api=original
 def test_invalid_user_duplicate_and_url_rejected_before_signing(self):
  body=self.body();body['access']['users']=[{'id':'123','note':''}];self.assertEqual(self.call('/api/prepare',body)[0],400)
  body['access']['users']=[{'id':'123456789012345678','note':''}]*2;self.assertEqual(self.call('/api/prepare',body)[0],400)
  self.assertEqual(self.call('/api/release?version=1.4.10&url=http://example.com/app',b'x',raw=True)[0],400);self.sign.assert_not_called()

 def test_blacklist_prepare_commit_and_validation(self):
  body=self.body();record={'id':'123456789012345678','note':'private note','reason':'public reason'}
  body['access']['blockedUsers']=[record]
  code,_,raw=self.call('/api/prepare',body);self.assertEqual(code,200)
  plan=json.loads(raw);self.assertEqual(plan['after']['access']['blockedUsers'],[record])
  self.assertEqual(self.call('/api/commit',{'ticket':plan['ticket']})[0],200)
  self.assertEqual(self.fixture.writes[-1]['access']['blockedUsers'],[record])
  for blocked in (None,[record,record],[{**record,'reason':'x'*301}],[{**record,'note':'x'*101}]):
   body['access']['blockedUsers']=blocked;self.assertEqual(self.call('/api/prepare',body)[0],400)

if __name__=='__main__':unittest.main()
