"""Local admin tool tests with disposable paths and no server calls."""
import base64,contextlib,io,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
import operations as ops
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

class AdminTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);root=Path(self.tmp.name)
  (root/'wrangler.jsonc').write_text('{"vars":{}}',encoding='utf-8')
  self.root=patch.object(ops,'ROOT',root);self.root.start();self.addCleanup(self.root.stop)
  self.directory=patch.object(ops,'ADMIN_DIR',root/'credentials');self.directory.start();self.addCleanup(self.directory.stop)
  self.quiet=contextlib.redirect_stdout(io.StringIO());self.quiet.__enter__();self.addCleanup(self.quiet.__exit__,None,None,None)
  if sys.platform!='win32':
   # Linux CI cannot call Windows DPAPI. Keep persistence/signature/backup tests
   # active with an encrypted, ephemeral test store; production remains DPAPI-only.
   from cryptography.fernet import Fernet
   cipher=Fernet(Fernet.generate_key())
   storage=patch.object(ops,'protect',side_effect=lambda data,decode=False: cipher.decrypt(data) if decode else cipher.encrypt(data))
   storage.start();self.addCleanup(storage.stop)
  ops.initialize()
 @unittest.skipUnless(sys.platform=='win32','Windows DPAPI integration is Windows-only')
 def test_secrets_are_encrypted_and_initialization_reuses_key(self):
  before=ops.credentials();cipher=(ops.ADMIN_DIR/'credentials.dat').read_bytes()
  self.assertNotIn(before['token'].encode(),cipher);self.assertNotIn(before['private'].encode(),cipher)
  ops.initialize();self.assertEqual(ops.credentials(),before)
 def test_signature_matches_exported_public_key(self):
  public=json.loads((ops.ROOT/'operations-public.json').read_text())['publicKey'];e=ops.seal({'fixture':'한글'})
  Ed25519PublicKey.from_public_bytes(bytes.fromhex(public)).verify(base64.b64decode(e['signature']),e['payload'].encode())
 def test_encrypted_backup_restore_and_wrong_password(self):
  before=ops.credentials();backup=ops.ROOT/'backup.dat'
  with patch('builtins.input',return_value=str(backup)),patch.object(ops.getpass,'getpass',return_value='test-password-only-123'):
   ops.backup()
  self.assertNotIn(before['token'].encode(),backup.read_bytes());(ops.ADMIN_DIR/'credentials.dat').unlink()
  with patch('builtins.input',return_value=str(backup)),patch.object(ops.getpass,'getpass',return_value='wrong-password-only-123'):
   with self.assertRaises(Exception):ops.backup(True)
  self.assertFalse((ops.ADMIN_DIR/'credentials.dat').exists())
  with patch('builtins.input',return_value=str(backup)),patch.object(ops.getpass,'getpass',return_value='test-password-only-123'):
   ops.backup(True)
  self.assertEqual(ops.credentials(),before)
 def test_publish_signs_new_revision_without_mutating_original(self):
  p=ops.defaults();a={'mode':'allowlist','users':[]}
  with patch('builtins.input',return_value='적용'),patch.object(ops,'api',return_value={'ok':True}) as api:ops.publish({'revision':7},p,a)
  request=api.call_args.args[1];signed=json.loads(request['envelope']['payload'])
  self.assertEqual(request['expectedRevision'],7);self.assertEqual(signed['revision'],8);self.assertEqual(signed['expiresAt']-signed['issuedAt'],30*86400000);self.assertEqual(p['revision'],0)
 def test_legacy_deadline_uses_korean_timezone_and_can_be_kept_or_disabled(self):
  p=ops.defaults();date='2026-10-16 18:30'
  now=ops.datetime(2026,10,15,tzinfo=ops.timezone.utc).timestamp()
  with patch.object(ops.time,'time',return_value=now),patch('builtins.input',return_value=date):ops.configure_legacy(p)
  expected=int(ops.datetime(2026,10,16,18,30,tzinfo=ops.timezone(ops.timedelta(hours=9))).timestamp()*1000)
  self.assertEqual(p['legacyUntil'],expected)
  with patch('builtins.input',return_value=''):ops.configure_legacy(p)
  self.assertEqual(p['legacyUntil'],expected)
  with patch('builtins.input',return_value='해제'):ops.configure_legacy(p)
  self.assertEqual(p['legacyUntil'],0)
 def test_legacy_deadline_rejects_past_and_malformed_dates(self):
  for value in ['not-a-date','2020-01-01 00:00','2100-01-01 00:00']:
   with patch('builtins.input',return_value=value):
    with self.assertRaises(ValueError):ops.configure_legacy(ops.defaults())
 def test_management_api_identifies_admin_client(self):
  with patch.object(ops,'build_opener') as opener:
   response=opener.return_value.open.return_value.__enter__.return_value;response.read.return_value=b'{"revision":1}'
   self.assertEqual(ops.api('/admin/state')['revision'],1)
   self.assertEqual(opener.return_value.open.call_args.args[0].get_header('User-agent'),'ErinnDeskAdmin/1.0')
 def test_cancel_publish_never_calls_server(self):
  with patch('builtins.input',return_value='취소'),patch.object(ops,'api') as api:ops.publish({'revision':0},ops.defaults(),{'mode':'allowlist','users':[]})
  api.assert_not_called()

if __name__=='__main__':unittest.main()
