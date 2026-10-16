"""Real local page + Edge, with an in-memory upstream (no production calls)."""
import copy,json,sys,tempfile,threading
from pathlib import Path
from unittest.mock import Mock
from playwright.sync_api import sync_playwright,expect
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
import admin_web as web
from test_admin_web import Fixture

fixture=Fixture();original=fixture.api
def api(path,body=None):
 result=original(path,body)
 if body:
  fixture.state['policy']=json.loads(body['envelope']['payload']);fixture.state['access']=copy.deepcopy(body['access'])
 return result
app=web.Application(api,lambda p:{'payload':json.dumps(p),'signature':'fixture-only'},lambda:{'ok':True,'commit':'abc123fixture'},Mock())
server=web.create_server(app=app);url=f'http://127.0.0.1:{server.server_port}/#session={app.token}';threading.Thread(target=server.serve_forever,daemon=True).start()
out=Path(r'C:\Users\LuLuFell_\Documents\Codex\2026-10-05\new-chat\outputs\admin-page');out.mkdir(parents=True,exist_ok=True)
try:
 with tempfile.TemporaryDirectory() as folder,sync_playwright() as p:
  browser=p.chromium.launch(channel='msedge',headless=True);page=browser.new_page(viewport={'width':1440,'height':1050});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(url);expect(page.locator('#latestLabel')).to_have_text('1.4.9');page.screenshot(path=str(out/'overview-dark.png'),full_page=True)
  page.get_by_role('button',name='디스코드 기능 점검',exact=True).click();page.locator('#feature-capture').uncheck();page.locator('#reason-capture').fill('캡처 기능 점검 중입니다.')
  page.locator('#preview').click();expect(page.locator('#confirm')).to_be_visible();expect(page.locator('#changes')).to_contain_text('캡처 기능 점검 중입니다.');assert fixture.writes==[]
  page.screenshot(path=str(out/'confirm-changes.png'));page.locator('#cancelApply').click();assert fixture.writes==[]
  page.locator('#preview').click();page.locator('#commit').click();expect(page.locator('#draftStatus')).to_contain_text('운영 서버에 적용했습니다');expect(page.locator('#status')).not_to_contain_text('운영 서버에 적용했습니다');assert len(fixture.writes)==1
  expect(page.locator('#feature-capture')).not_to_be_checked()
  page.get_by_role('button',name='버전 관리',exact=True).click();file=Path(folder)/'ErinnDesk.exe';file.write_bytes(b'local fake EXE test fixture')
  expect(page.locator('#releases')).to_contain_text('https://example.com/app.exe')
  page.locator('[data-version-url="1.4.9"]').click();expect(page.locator('#urlDialog')).to_be_visible()
  page.locator('#newReleaseUrl').fill('https://example.com/moved.exe');app.downloader.side_effect=ValueError('파일이 다릅니다.')
  page.locator('#verifyUrl').click();expect(page.locator('#urlStatus')).to_contain_text('파일이 다릅니다');expect(page.locator('#status')).not_to_contain_text('파일이 다릅니다')
  app.downloader.side_effect=None;page.locator('#verifyUrl').click();expect(page.locator('#urlDialog')).not_to_be_visible();expect(page.locator('#releases')).to_contain_text('https://example.com/moved.exe');expect(page.locator('#latest')).to_have_value('1.4.9');assert len(fixture.writes)==1;app.downloader.reset_mock()
  expect(page.locator('#releaseVersion')).to_have_value('1.4.9')
  page.locator('#verifyFile').click();expect(page.locator('#verifyStatus')).to_contain_text('파일 선택');app.downloader.assert_not_called()
  page.locator('#releaseVersion').fill('v1.4.9');page.locator('#verifyFile').click();expect(page.locator('#verifyStatus')).to_contain_text('v는 붙이지 않습니다');expect(page.locator('#verifyStatus')).to_have_class('hint error');expect(page.locator('#status')).not_to_contain_text('v는 붙이지 않습니다');app.downloader.assert_not_called()
  page.locator('#releaseVersion').fill('1.4.10')
  with page.expect_file_chooser() as chosen:page.locator('#browseReleaseFile').click()
  chosen.value.set_files(str(file))
  page.locator('#releaseUrl').fill('https://example.com/new.exe');expect(page.locator('#releaseFileName')).to_have_text('ErinnDesk.exe');assert page.locator('#browseReleaseFile').bounding_box()['x']>page.locator('#releaseFileName').bounding_box()['x'];page.locator('#verifyFile').click()
  expect(page.locator('#verifyStatus')).to_contain_text('파일이 일치합니다');app.downloader.assert_called_once();assert len(fixture.writes)==1
  expect(page.locator('#latest')).to_have_value('1.4.10');page.evaluate('window.scrollTo(0,0)');page.screenshot(path=str(out/'versions-dark.png'),full_page=True)
  expect(page.locator('#releaseCount')).to_have_text('2개')
  for width in (930,850):
   page.set_viewport_size({'width':width,'height':1050})
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),width
   for record in page.locator('.release-record').all():
    assert record.locator('.release-detail code').inner_text()
    assert record.locator('.release-version strong').bounding_box()['height']<25
    assert record.locator('.release-detail a').bounding_box()['width']>200
  page.set_viewport_size({'width':930,'height':1050})
  page.locator('footer').evaluate('(n)=>n.hidden=true')
  page.locator('[data-page=versions] .panel').last.screenshot(path=str(out/'narrow-releases-applied.png'))
  page.locator('footer').evaluate('(n)=>n.hidden=false')
  page.set_viewport_size({'width':1440,'height':1050})
  page.get_by_role('button',name='디스코드 사용자 관리',exact=True).click();page.get_by_role('combobox',name='디스코드 이용 대상').click();page.get_by_role('option',name='허용 목록만',exact=True).click()
  page.locator('#userId').fill('123456789012345678');page.locator('#userNote').fill('<테스터>');page.locator('#addUser').click();expect(page.locator('#users')).to_contain_text('<테스터>');assert page.locator('#users script').count()==0
  page.locator('#blockedUserId').fill('123456789012345678');page.locator('#blockedUserNote').fill('관리자 전용 메모');page.locator('#blockedUserReason').fill('테스트 안내 사유');page.locator('#addBlockedUser').click()
  expect(page.locator('#blockedUsers')).to_contain_text('사유 : 테스트 안내 사유');expect(page.locator('#blockedUsers')).to_contain_text('관리자 전용 메모')
  page.locator('#preview').click();expect(page.locator('#changes')).to_contain_text('허용 목록만');expect(page.locator('#changes')).to_contain_text('1.4.10');expect(page.locator('#changes')).to_contain_text('테스트 안내 사유');page.locator('#commit').click();expect(page.locator('#draftStatus')).to_contain_text('운영 서버에 적용했습니다');expect(page.locator('#status')).not_to_contain_text('운영 서버에 적용했습니다');assert len(fixture.writes)==2;assert fixture.state['access']['blockedUsers'][0]['reason']=='테스트 안내 사유'
  page.locator('#theme').click();expect(page.locator('html')).to_have_attribute('data-theme','light');page.screenshot(path=str(out/'access-light.png'),full_page=True)
  page.get_by_role('button',name='변경 이력',exact=True).click();page.get_by_role('button',name='이 설정으로 복원').first.click();expect(page.locator('#confirm')).to_be_visible();assert len(fixture.writes)==2;page.locator('#cancelApply').click()
  page.get_by_role('button',name='버전 관리',exact=True).click();page.locator('#updateMessage').fill('아직 미적용');page.locator('#discard').click();expect(page.locator('#discardDialog')).to_be_visible();page.locator('#confirmDiscard').click();expect(page.locator('#updateMessage')).not_to_have_value('아직 미적용')
  assert not errors,errors;browser.close()
 # Failure to configure upstream is shown as preparation guidance, without enabling writes.
 app.api=Mock(side_effect=ValueError('fixture unavailable'))
 with sync_playwright() as p:
  browser=p.chromium.launch(channel='msedge',headless=True);page=browser.new_page();page.goto(url.split('#')[0]);expect(page.locator('#status')).to_contain_text('관리 세션이 없습니다');app.api.assert_not_called();page.goto(url);expect(page.locator('#setup')).to_be_visible();expect(page.locator('#preview')).to_be_disabled();browser.close()
 print('PASS admin UI: dashboard, staged feature editing, cancel/commit, EXE verification, access list, restore preview, discard, themes and setup guidance')
finally:server.shutdown();server.server_close()
