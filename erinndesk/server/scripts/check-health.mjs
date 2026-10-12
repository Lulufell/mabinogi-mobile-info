const url='https://erinn-desk-remote.lulufell.workers.dev/health';
if(!process.env.GITHUB_SHA)throw new Error('Missing expected deployment commit');
let passed=false;
for(let attempt=0;attempt<6;attempt++){
 try{
  const response=await fetch(url,{headers:{'User-Agent':'ErinnDeskDeploy/1.0','Cache-Control':'no-cache'},signal:AbortSignal.timeout(10000)});
  const data=await response.json();
  if(response.ok && data.ok===true && data.service==='Erinn Desk Remote' && data.commit===process.env.GITHUB_SHA){passed=true;break;}
 }catch{}
 await new Promise(resolve=>setTimeout(resolve,5000));
}
if(!passed)throw new Error('Deployment health/commit verification failed. Inspect Cloudflare deployment; no automatic rollback was performed.');
console.log('PASS deployed commit matches expected commit');
