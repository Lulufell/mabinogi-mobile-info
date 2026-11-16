(()=>{
 let state, timer, generation=0, search='',opened=new Set(),saving=Promise.resolve();
 const favoriteKey=r=>r.series+'|'+r.name;
 const favorite=r=>window.webFavorites().includes(favoriteKey(r));
 const scope=r=>state.preferences.series==='즐겨찾기'?favorite(r):r.series===state.preferences.series;
 const clean=n=>n.replace(/ZZ$/,'');
 const kind=r=>r.ingredients.some(i=>i.name==='세공된 페리도트ZZ')?'장신구':/갑옷|전투복/.test(r.name)?'방어구':'무기';
 const number=n=>n==null?'계산 불가':n.toLocaleString('ko-KR',{maximumFractionDigits:0});
 const active=()=>document.querySelector('#marketCostPage');
 const display=window.marketDisplay;
 const materialRank=new Map(display.armorOrder.materials.map((n,i)=>[n,i]));
 const slotRank=new Map(display.armorOrder.slots.map((n,i)=>[n,i]));
 const rank=(name,indices)=>{for(const [part,index] of indices)if(name.includes(part))return index;return 999;};
 const armorSort=(a,b)=>rank(a.name,materialRank)-rank(b.name,materialRank)||rank(a.name,slotRank)-rank(b.name,slotRank)||a.name.localeCompare(b.name,'ko');
 const icon=n=>window.marketIcons?.[n]?`<img class="market-item-icon" src="${esc(window.marketIcons[n])}" alt="" loading="lazy">`:'';
 const job=r=>r.job||display.weaponJobs[clean(r.name).replace(/^(잔영|해연)의 /,'')]||'';
 const armorSlot=r=>kind(r)==='방어구'?(display.armorOrder.slots.find(slot=>clean(r.name).endsWith(' '+slot))||''):'';
 const categoryDetail=r=>kind(r)==='무기'?job(r):armorSlot(r);

 function rows(){
  if(!active()||!state)return;
  const pref=state.preferences, prices=Object.fromEntries(state.prices.map(p=>[p.name,p.is_sold_out||p.total_count===0?null:p.min_price]));
  const available=['무기','방어구','장신구'].filter(c=>state.recipes.some(r=>scope(r)&&(c==='전체'||kind(r)===c)));if(pref.series==='즐겨찾기')available.unshift('전체');if(!available.includes(pref.category))pref.category=available[0]||'무기';
  const recipes=state.recipes.filter(r=>scope(r)&&(pref.category==='전체'||kind(r)===pref.category)&&(clean(r.name)+' '+kind(r)+' '+categoryDetail(r)).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  if(pref.series==='즐겨찾기'){const order=window.webFavorites();recipes.sort((a,b)=>order.indexOf(favoriteKey(a))-order.indexOf(favoriteKey(b)));}else if(pref.category==='방어구')recipes.sort(armorSort);
  document.querySelector('#marketCategories').innerHTML=available.map(c=>`<button data-category="${c}" class="${pref.category===c?'selected':''}">${c}<small>${state.recipes.filter(r=>scope(r)&&(c==='전체'||kind(r)===c)).length}</small></button>`).join('');
  document.querySelectorAll('#marketCostPage [data-series]').forEach(b=>b.classList.toggle('selected',b.dataset.series===pref.series));
  document.querySelectorAll('#marketCostPage [data-option]').forEach(b=>b.setAttribute('aria-checked',String(pref[b.dataset.option])));
  document.querySelector('#marketCount').textContent=`${pref.category} ${recipes.length}종`;
  document.querySelector('#marketList').innerHTML=recipes.map(r=>{
   let sum=0, unknown=false, unpriced=false;
   const ingredients=r.ingredients.map(i=>{
    const noPrice=i.tradable===false||i.name==='세공된 페리도트ZZ',excluded=pref.exclude&&!noPrice&&!/영혼석|마력석/.test(i.name),price=prices[i.name];
    if(noPrice)unpriced=true;else if(!excluded){if(price==null)unknown=true;else sum+=price*i.quantity;}
    return `<tr class="${excluded?'excluded':''}"><td><span class="market-material-name">${icon(i.name)}${esc(clean(i.name))}</span>${noPrice?'<span class="badge">거래 불가</span>':excluded?'<span class="badge">계산 제외</span>':''}</td><td>${number(i.quantity)}</td><td>${noPrice?'가격 없음':price==null?'시세 없음':number(price)}</td><td>${noPrice?'가격 없음':excluded?'제외':price==null?'시세 없음':number(price*i.quantity)}</td></tr>`;
   }).join('');
   const price=prices[r.name],sale=price==null?null:pref.sale?Math.floor(price*85/100):price;
   const diff=unknown||sale==null?null:sale-sum;
   const delta=diff==null?'계산 불가':`${diff>=0?'+':'−'}${number(Math.abs(diff))}`,color=diff==null?'':diff>=0?'good':'bad';
   return `<article class="card ${opened.has(r.recipeId)?'open':''}"><button type="button" class="favorite-button" data-favorite="${esc(r.recipeId)}" aria-pressed="${favorite(r)}" aria-label="${esc(clean(r.name))} 즐겨찾기 ${favorite(r)?'해제':'추가'}">${favorite(r)?'★':'☆'}</button><button class="itemhead" data-item="${esc(r.recipeId)}" aria-expanded="${opened.has(r.recipeId)}"><span class="market-equipment-name">${icon(r.name)}<span class="itemname">${esc(clean(r.name))}<small>${esc(r.series)} · ${kind(r)}${categoryDetail(r)?' · '+esc(categoryDetail(r)):''}</small></span></span><span class="pricebox"><span class="price"><small>${pref.sale?'판매가 · 수수료 15% 제외':'아이템 가격'}</small>${sale==null?(r.series==='드래케인'?'거래소 매물 없음':'시세 없음'):number(sale)}</span><span class="compact-diff ${color}"><small>제작비</small><span class="compact-cost">${number(unknown?null:sum)}</span><span class="compact-profit">${delta}</span></span><span class="chevron"></span></span></button><div class="detail"><div class="tabletitle">레시피<span>필요 수량 × 개당 가격</span></div><table><thead><tr><th>재료명</th><th>필요 수량</th><th>개당 가격</th><th>총 가격</th></tr></thead><tbody>${ingredients}</tbody></table><div class="summary"><div><label>총 제작비용${pref.exclude?' · 영혼석·마력석 기준':unpriced?' · 거래 가능 재료 기준':''}</label><strong>${number(unknown?null:sum)}</strong><small>재료별 총 가격 합계</small></div><div><label>제작 시</label><strong class="${color}">${delta}</strong><small>${pref.sale?'판매 수수료 차감 금액':'아이템 가격'} − 제작비용</small></div></div>${unpriced?'<p class="note">거래 불가 재료는 합계에서 제외됩니다. 제작에는 해당 재료가 필요합니다.</p>':''}</div></article>`;
  }).join('')||(pref.series==='즐겨찾기'&&!state.recipes.some(favorite)?'<div class="favorite-empty">아직 즐겨찾기가 없습니다.<br>장비 카드의 ☆을 눌러 추가하세요.</div>':'<div class="empty">해당 품목이 없습니다.</div>');
  status();
 }
 function status(){
  if(!active()||!state)return;
  const remain=Math.max(0,Math.ceil(state.nextRefresh-Date.now()/1000)),b=document.querySelector('#marketRefresh');
  b.disabled=state.busy||remain>0||(state.preferences.personalAPI&&!state.hasKey);
  b.textContent=state.busy?'조회 중…':remain?`새로고침 · ${Math.floor(remain/60)}:${String(remain%60).padStart(2,'0')}`:'↻ 새로고침';
  document.querySelector('#marketTime').textContent=state.updatedAt?(state.source==='personal'?'개인 시세 조회':'서버 시세 조회')+' · '+new Date(state.updatedAt*1000).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',hour12:false})+' 갱신':'조회 전';
  window.renderMobiKeyPanel(document.querySelector('#marketKeyActions'),{hasKey:state.hasKey||!state.preferences.personalAPI,error:state.preferences.personalAPI?state.error:''});
  document.querySelector('#marketStatus').textContent=state.busy?'시세를 조회하고 있습니다.':state.error||state.serverError||'';
 }
 async function refresh(){try{state=await window.bridgeFetch('/api/market-costs/refresh',{});rows();}catch(e){if(active())document.querySelector('#marketStatus').textContent=e.message;}}
 async function poll(id){
  if(id!==generation||!active())return;
  try{const next=await window.bridgeFetch('/api/market-costs');if(id!==generation||!active())return;const changed=state.busy!==next.busy||state.updatedAt!==next.updatedAt||state.source!==next.source;state=next;if(changed)rows();else status();}catch(e){if(active())document.querySelector('#marketStatus').textContent=e.message;}
  if(id===generation&&active())timer=setTimeout(()=>poll(id),1000);
 }
 window.addEventListener('mobi-key-changed',()=>{if(active())window.renderMarketCosts();});
 window.renderMarketCosts=async()=>{
  clearTimeout(timer);const id=++generation;opened.clear();search='';
  document.querySelector('#view').innerHTML=`<section id="marketCostPage"><div class="page-head"><h1>장비 제작비 계산기</h1><p class="web-subtitle">재료를 모아 제작할지, 완제품을 구매할지 비교해보세요.</p></div><p class="hint chat-source"><strong>모비라이프 제공</strong> · 거래소 최저가를 기준으로 제작비를 비교합니다.<br><a href="https://open.mabimobi.life/docs" target="_blank" rel="noopener noreferrer">모비라이프 API 안내 ↗</a></p><div class="section-heading"><h2>제작비 비교</h2><div class="tools"><span id="marketTime" class="hint"></span> <button id="marketRefresh">↻ 새로고침</button></div></div><div class="filter panel"><div class="series"><button data-series="즐겨찾기">즐겨찾기</button><button data-series="잔영">잔영</button><button data-series="해연">해연</button><button data-series="드래케인">드래케인</button></div><input class="search" id="marketSearch" placeholder="아이템 이름, 직업 또는 부위로 검색" aria-label="아이템 이름, 직업 또는 부위로 검색"></div><div class="categorybar"><div class="categories" id="marketCategories"></div><div class="toggle-group"><button class="sale-toggle" role="switch" data-option="sale" aria-checked="false">판매가<span class="switchbar"></span></button><button class="sale-toggle" role="switch" data-option="exclude" aria-checked="false">가공 재료 제외<span class="switchbar"></span></button></div></div><div id="marketKeyActions" hidden></div><p class="status" id="marketStatus" role="status"></p><div class="listhead"><b id="marketCount"></b><span class="hint">거래소 최저가 기준 · 1개 제작</span></div><div id="marketList"></div><p class="preview">서버 시세는 3분마다 갱신됩니다. 즐겨찾기는 이 브라우저에 저장됩니다.<br>제작 시 = 아이템 가격(판매가 선택 시 수수료 15% 차감) − 재료비 · 제작 부대비용 제외</p></section>`;
  document.querySelector('#marketRefresh').onclick=refresh;
  document.querySelector('#marketSearch').oninput=e=>{search=e.target.value;rows()};
  active().onclick=e=>{
   const b=e.target.closest('button');if(!b||!state)return;
   if(b.dataset.favorite){const r=state.recipes.find(r=>r.recipeId===b.dataset.favorite);window.webToggleFavorite(favoriteKey(r));rows();return;}
   if(b.dataset.option==='personalAPI'&&!state.preferences.personalAPI&&!state.hasKey){window.openMobiApiKey();return;}
   if(b.dataset.item){const key=b.dataset.item;opened.has(key)?opened.delete(key):opened.add(key);rows();return;}
   let change=b.dataset.series?{series:b.dataset.series,...(b.dataset.series==='드래케인'?{category:'무기'}:b.dataset.series==='즐겨찾기'?{category:'전체'}:{})}:b.dataset.category?{category:b.dataset.category}:b.dataset.option?{[b.dataset.option]:!state.preferences[b.dataset.option]}:null;
   if(!change)return;Object.assign(state.preferences,change);rows();
   saving=saving.then(()=>window.bridgeFetch('/api/market-costs/settings',change)).catch(e=>{if(active())document.querySelector('#marketStatus').textContent=e.message;});
  };
  try{await saving;state=await window.bridgeFetch('/api/market-costs');if(id!==generation||!active())return;rows();if((!state.preferences.personalAPI||state.hasKey)&&!state.busy&&state.nextRefresh<=Date.now()/1000)await refresh();timer=setTimeout(()=>poll(id),1000);}catch(e){if(active())document.querySelector('#marketStatus').textContent=e.message;}
 };
})();
