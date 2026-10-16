"""Exercise the real client UI with a synthetic local API, no Discord/game calls."""
import argparse,re,json
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
p=argparse.ArgumentParser();p.add_argument('--app-root',type=Path,required=True);p.add_argument('--output',type=Path,required=True);args=p.parse_args();site=args.app_root/'outputs/erinn-web/site';args.output.mkdir(parents=True,exist_ok=True)
html=(site/'index.html').read_text(encoding='utf-8');html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link\b[^>]*rel="stylesheet"[^>]*>','',html);html=html.replace('<html lang="ko">','<html lang="ko" data-theme="dark">');html=html.replace('</head>','<style>'+''.join((site/n).read_text(encoding='utf-8')for n in ['style.css','pastel.css','queue.css','workflows.css'])+'</style></head>')
state={'url':'https://example.invalid','state':'connected','enabled':True,'linked':{'id':'123456789012345678','name':'테스트 계정','avatarUrl':'https://cdn.discordapp.com/embed/avatars/0.png'},'history':[{'name':'가죽 '+str(i),'at':'2026-10-16T02:00:00Z','ok':True}for i in range(20)],'captureEnabled':False,'captureNext':0,'error':''}
with sync_playwright() as p:
 b=p.chromium.launch(channel='msedge',headless=True);page=b.new_page(viewport={'width':1220,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.set_content(html)
 page.route('https://cdn.discordapp.com/**',lambda route:route.fulfill(status=200,content_type='image/png',body=__import__('base64').b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHVEAAAAASUVORK5CYII=')))
 page.evaluate('s=>{window.fixture=s;window.calls=[];window.bridgeFetch=async(path,body)=>{calls.push([path,body]);if(body?.action==="clear-history")fixture.history=[];if(path.endsWith("settings")){fixture.enabled=body.enabled;fixture.state=body.enabled?"connected":"disabled";}return structuredClone(fixture);};}',state)
 page.add_script_tag(content=(site/'remote-ui.js').read_text(encoding='utf-8'));page.evaluate('renderRemote()');expect(page.locator('#remoteHistoryTitle')).to_have_text('최근 원격 조회 · 20건')
 expect(page.get_by_role('heading',name='디스코드 연결 (Beta)',exact=True)).to_be_visible();expect(page.locator('#remoteServerInvite')).to_be_visible();expect(page.locator('.remote-server-link')).to_have_attribute('href','https://discord.gg/hkCFtBM29w')
 expect(page.locator('.remote-avatar img')).to_have_attribute('src','https://cdn.discordapp.com/embed/avatars/0.png')
 assert page.locator('.remote-history-row').count()==20;assert page.locator('#remoteHistory').evaluate('e=>e.scrollHeight>e.clientHeight');assert page.locator('#remoteHistory').bounding_box()['height']<=281
 assert page.get_by_role('button',name='디스코드로 연결',exact=False).count()==0
 page.screenshot(path=str(args.output/'discord-final-connected.png'),full_page=True)
 page.locator('#remoteClear').click();expect(page.locator('#remoteConfirm')).to_be_visible();page.get_by_role('button',name='취소',exact=True).click();assert page.evaluate('fixture.history.length')==20
 page.locator('#remoteClear').click();page.get_by_role('button',name='지우기',exact=True).click();expect(page.locator('#remoteHistoryTitle')).to_have_text('최근 원격 조회 · 0건');assert page.evaluate('fixture.linked.id')=='123456789012345678'
 page.locator('#remoteUse').click();expect(page.locator('.remote-account-state')).to_contain_text('원격 조회 꺼짐');expect(page.get_by_role('button',name='연결 해제',exact=True)).to_be_visible()
 page.evaluate('fixture.linked=null;fixture.enabled=false;fixture.state="disabled";renderRemote()');expect(page.get_by_role('button',name='디스코드로 연결 ↗',exact=True)).to_be_visible();expect(page.locator('#remoteUse')).to_be_hidden();expect(page.locator('#remoteServerInvite')).to_be_hidden();page.screenshot(path=str(args.output/'discord-final-disconnected.png'),full_page=True)
 page.get_by_role('button',name='디스코드로 연결 ↗',exact=True).click();assert page.evaluate('calls.some(c=>c[1]?.action==="oauth-start")')
 assert not errors,errors;b.close()
print('PASS OAuth UI: 20-record scroll, clear/cancel, retained account when paused, login and no legacy controls')
