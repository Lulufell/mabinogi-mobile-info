import contextlib,io,json,os,unittest
from unittest.mock import patch
from urllib.error import HTTPError
import manage

class RegistrationTests(unittest.TestCase):
 def test_ci_missing_token_fails_without_prompt(self):
  with patch.dict(os.environ,{'CI':'true','DISCORD_BOT_TOKEN':''},clear=True),patch('manage.getpass.getpass') as prompt:
   with self.assertRaisesRegex(ValueError,'DISCORD_BOT_TOKEN'):manage.registration_token()
   prompt.assert_not_called()
 def test_environment_token_registers_expected_commands(self):
  app=json.loads((manage.ROOT/'wrangler.jsonc').read_text())['vars']['DISCORD_APPLICATION_ID']
  calls=[]
  def response(req,timeout):
   calls.append(req)
   return io.BytesIO(json.dumps({'bot':True,'id':app} if len(calls)==1 else manage.COMMANDS).encode())
  with patch.dict(os.environ,{'CI':'true','DISCORD_BOT_TOKEN':'fixture.secret'},clear=True),patch('manage.urlopen',side_effect=response),patch('manage.getpass.getpass') as prompt,contextlib.redirect_stdout(io.StringIO()) as output:
   manage.register()
   prompt.assert_not_called()
   self.assertEqual(calls[1].method,'PUT')
   self.assertEqual({x['name'] for x in json.loads(calls[1].data)}, {'연결','아이템','연결상태','스크린샷','연결해제'})
   self.assertNotIn('fixture.secret',output.getvalue())
 def test_interactive_prompt_still_supported(self):
  with patch.dict(os.environ,{},clear=True),patch('manage.sys.stdin.isatty',return_value=True),patch('manage.getpass.getpass',return_value='local.secret'):
   self.assertEqual(manage.registration_token(),'local.secret')
 def test_wrong_bot_never_updates_commands(self):
  with patch.dict(os.environ,{'DISCORD_BOT_TOKEN':'fixture.secret'},clear=True),patch('manage.urlopen',return_value=io.BytesIO(b'{"bot":true,"id":"wrong"}')) as request:
   with self.assertRaisesRegex(ValueError,'Application ID'):manage.register()
   self.assertEqual(request.call_count,1)

if __name__=='__main__':unittest.main()
