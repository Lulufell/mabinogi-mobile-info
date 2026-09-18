'use strict';
window.bridgeSettings={base:'',token:''};
window.bridgeFetch=async function(path,body){
 const {base,token}=window.bridgeSettings;
 if(!base||!token)throw new Error('먼저 로컬 서버를 연결하세요.');
 let r;
 try{r=await fetch(base+path,{method:body?'POST':'GET',mode:'cors',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(10000),targetAddressSpace:'loopback',headers:{'X-Erinn-Token':token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})})}
 catch(e){throw new Error('서버 실행 상태, 포트, 허용한 사이트 주소와 브라우저의 로컬 네트워크 권한을 확인하세요.')}
 const data=await r.json();if(!r.ok)throw new Error(data.error||'연결 실패');return data;
};
window.showBridge=()=>document.querySelector('#bridgeDialog').showModal();
document.addEventListener('DOMContentLoaded',()=>{
 const dialog=document.querySelector('#bridgeDialog');
 document.querySelector('#bridgeOrigin').textContent=location.origin;
 document.querySelector('#bridgeOpen').onclick=window.showBridge;
 document.querySelector('#bridgeClose').onclick=()=>dialog.close();
 document.querySelector('#bridgeForm').onsubmit=async e=>{
  e.preventDefault();const button=document.querySelector('#bridgeSubmit');button.disabled=true;
  try{
   const port=Number(document.querySelector('#bridgePort').value);
   const token=document.querySelector('#bridgeKey').value.trim();
   if(!Number.isInteger(port)||port<1||port>65535||!/^[A-Za-z0-9_-]{40,100}$/.test(token))throw new Error('포트와 연결 키를 확인하세요.');
   window.bridgeSettings={base:`http://127.0.0.1:${port}`,token};
   await window.bridgeFetch('/api/state');
   await window.startBridgeSession();dialog.close();
  }catch(err){document.querySelector('#bridgeError').textContent=err.message;}
  finally{button.disabled=false;}
 };
 dialog.showModal();
});
