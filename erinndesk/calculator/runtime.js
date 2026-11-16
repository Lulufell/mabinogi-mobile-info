/* Public read-only calculator. Personal keys and app endpoints are never used. */
(()=>{
 const PREFIX='erinn-web-calculator-v1';
 function read(key,fallback){try{return JSON.parse(localStorage.getItem(PREFIX+key))??fallback}catch{return fallback}}
 function save(key,value){try{localStorage.setItem(PREFIX+key,JSON.stringify(value))}catch{const n=document.querySelector('#marketStatus');if(n)n.textContent='브라우저 저장 공간을 사용할 수 없어 설정이 이번 접속에만 유지됩니다.'}}
 const preferences={series:'해연',category:'무기',sale:false,exclude:false,personalAPI:false};const stored=read('-preferences',{});
 if(['즐겨찾기','잔영','해연','드래케인'].includes(stored.series))preferences.series=stored.series;if(['전체','무기','방어구','장신구'].includes(stored.category))preferences.category=stored.category;for(const k of ['sale','exclude'])if(typeof stored[k]==='boolean')preferences[k]=stored[k];
 let favorites=read('-favorites',[]);const keys=new Set(window.webRecipes.map(r=>r.series+'|'+r.name));favorites=Array.isArray(favorites)?[...new Set(favorites.filter(k=>keys.has(k)))]:[];
 window.webFavorites=()=>favorites.slice();window.webToggleFavorite=key=>{favorites=favorites.includes(key)?favorites.filter(k=>k!==key):[...favorites,key];save('-favorites',favorites)};
 const state={recipes:window.webRecipes,preferences,prices:[],updatedAt:0,nextRefresh:0,source:'server',busy:false,hasKey:true,error:''};let flight=null;
 async function update(){
  if(flight||Date.now()/1000<state.nextRefresh||document.hidden)return flight;
  state.busy=true;flight=(async()=>{try{
   const r=await fetch('https://erinn-desk-remote.lulufell.workers.dev/market-prices',{credentials:'omit',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error();const data=await r.json();const now=Date.now()/1000;
   if(!Array.isArray(data.prices)||!Number.isFinite(data.updatedAt)||data.updatedAt<0||data.updatedAt>now+60||!Number.isFinite(data.nextRefresh)||data.nextRefresh>now+3600)throw Error();
   if(data.prices.some(p=>typeof p.name!=='string'||!Number.isSafeInteger(p.min_price)||p.min_price<0||!Number.isSafeInteger(p.total_count)||p.total_count<0||typeof p.is_sold_out!=='boolean'))throw Error();
   if(data.updatedAt>=state.updatedAt){state.prices=data.prices;state.updatedAt=data.updatedAt;}
   state.nextRefresh=Math.max(now+10,data.nextRefresh);state.error=typeof data.error==='string'?data.error:'';
  }catch{state.error='서버 시세를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.';state.nextRefresh=Date.now()/1000+30;}finally{state.busy=false;flight=null;}})();return flight;
 }
 window.esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));window.renderMobiKeyPanel=()=>{};
 window.bridgeFetch=async(path,data)=>{
  if(path.endsWith('/settings')){for(const k of ['series','category','sale','exclude'])if(k in data)preferences[k]=data[k];save('-preferences',preferences);}
  else await update();return structuredClone(state);
 };
 const theme=read('-theme','dark');document.documentElement.dataset.theme=theme==='light'?'light':'dark';const b=document.querySelector('#webTheme');const label=()=>b.textContent=document.documentElement.dataset.theme==='light'?'☀ 라이트 모드':'☾ 다크 모드';label();b.onclick=()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='light'?'dark':'light';save('-theme',document.documentElement.dataset.theme);label()};
 window.addEventListener('storage',e=>{if(e.key===PREFIX+'-favorites'){const v=read('-favorites',[]);favorites=Array.isArray(v)?v.filter(k=>keys.has(k)):[];window.renderMarketCosts();}});
})();
