export const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
});
export const reply = content => json({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } });
export const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2,'0')).join('');
export function hex(value) {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{2})+$/i.test(value)) throw new Error('Invalid hex');
  return Uint8Array.from(value.match(/../g), b => parseInt(b,16));
}
export async function verifyDiscord(request, body, publicKey, now = Date.now()) {
  try {
    const timestamp = request.headers.get('X-Signature-Timestamp'), signature = request.headers.get('X-Signature-Ed25519');
    if (!/^\d{10,13}$/.test(timestamp || '') || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
    const key = await crypto.subtle.importKey('raw', hex(publicKey), { name:'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, hex(signature), new TextEncoder().encode(timestamp + body));
  } catch { return false; }
}
export function validateName(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 120 && !/[\x00-\x1f\x7f]/.test(value);
}
export function safeText(value) { return String(value ?? '').replace(/[\x00-\x1f\x7f]/g,' ').replace(/([\\`*_~|>])/g,'\\$1').replace(/@/g,'＠'); }
export function formatItems(result) {
  if (!result || result.ok !== true) return ({busy:'PC에서 다른 수량 조회가 진행 중입니다. 잠시 후 다시 요청하세요.',timeout:'게임 조회 시간이 초과되었습니다. PC에서 게임 연결을 확인하세요.',invalid_request:'조회할 품목 이름을 확인하세요.'})[result?.error] || '게임에서 수량을 조회하지 못했습니다. PC에서 게임과 AI 커넥터 연결을 확인하세요.';
  if (!Array.isArray(result.items)) return 'PC가 올바른 조회 결과를 반환하지 않았습니다.';
  const locations = {inventory:'가방',account_storage:'계정 창고',character_storage:'캐릭터 창고'};
  const lines = ['**아이템 수량 조회**'];
  for (const item of result.items.slice(0,20)) {
    if (!item || typeof item.name !== 'string' || !item.locations || typeof item.locations !== 'object') continue;
    const values = Object.entries(item.locations).filter(([,n])=>Number.isSafeInteger(n)&&n>=0);
    lines.push(`\n**${safeText(item.name).slice(0,140)}**${item.category ? ' · '+safeText(item.category).slice(0,50) : ''}`);
    if (!Object.hasOwn(item.locations,'inventory')) values.unshift(['inventory',0]);
    for (const [location,count] of values) lines.push(`${safeText(locations[location] || location).slice(0,40)}: ${count.toLocaleString('ko-KR')}개`);
    if (Number.isSafeInteger(item.locked) && item.locked > 0) lines.push(`위 수량 중 잠긴 아이템: ${item.locked.toLocaleString('ko-KR')}개`);
  }
  if (!result.items.length) lines.push('검색에 일치하는 품목이 없습니다. 품목 이름을 확인하세요.');
  if (result.truncated) lines.push('\n결과가 많아 일부만 표시합니다. 이름을 더 구체적으로 입력하세요.');
  const date = new Date(result.at);
  if (!Number.isNaN(date.valueOf())) lines.push('\n조회 시각: '+new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',dateStyle:'short',timeStyle:'medium'}).format(date));
  return lines.join('\n').slice(0,1850);
}
