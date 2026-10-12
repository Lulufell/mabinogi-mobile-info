import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync,sign } from 'node:crypto';
import {verifyDiscord,formatItems,validateName} from '../src/protocol.js';

test('real Ed25519 signature, tampering and stale timestamp',async()=>{
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const key=publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');
 const timestamp=String(Math.floor(Date.now()/1000)),body='{"type":1}';
 const signature=sign(null,Buffer.from(timestamp+body),privateKey).toString('hex');
 const request=new Request('https://test/discord',{headers:{'X-Signature-Timestamp':timestamp,'X-Signature-Ed25519':signature}});
 assert.equal(await verifyDiscord(request,body,key),true);
 assert.equal(await verifyDiscord(request,body+' ',key),false);
 assert.equal(await verifyDiscord(request,body,key,Date.now()+600000),false);
});
test('names are bounded and control characters refused',()=>{
 assert(validateName('최상급 가죽'));assert(!validateName(''));assert(!validateName('가\n죽'));assert(!validateName('x'.repeat(121)));
});
test('counts, failure, no matches, escaped mentions and response size',()=>{
 const result=formatItems({ok:true,items:[{name:'가죽 @everyone',locations:{inventory:3,account_storage:10},locked:2}],at:new Date().toISOString()});
 assert(result.includes('가방: 3개'));assert(result.includes('계정 창고: 10개'));assert(!result.includes('@everyone'));
 assert(!formatItems({ok:false,error:'game_unavailable'}).includes('0개'));
 assert(formatItems({ok:true,items:[]}).includes('일치하는 품목이 없습니다'));
 assert(formatItems({ok:true,items:Array(30).fill({name:'가죽'.repeat(100),locations:{inventory:3}})}).length<=1850);
});
