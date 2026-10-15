import test from 'node:test';
import assert from 'node:assert/strict';
import {denial,validateAccess} from '../src/operations.js';
const id='123456789012345678';
const policy={expiresAt:Date.now()+3600000,features:Object.fromEntries(['discord','link','items','capture'].map(k=>[k,{enabled:true,reason:''}]))};
test('blacklist overrides allowlist and never discloses private note',()=>{
 const access={mode:'allowlist',users:[{id,note:''}],blockedUsers:[{id,note:'PRIVATE',reason:'案内'}]};
 validateAccess(access);
 for(const feature of ['link','items','capture','discord'])assert.equal(denial(policy,access,feature,id), '디스코드 기능 이용이 제한된 계정입니다.\n사유 : 案内');
 access.mode='all';access.blockedUsers[0].reason='  ';assert.equal(denial(policy,access,'items',id),'디스코드 기능 이용이 제한된 계정입니다.');
 assert.equal(denial(policy,access,'items','999999999999999999'),null);
 access.mode='maintenance';assert.equal(denial(policy,access,'items',id),'디스코드 기능을 점검하고 있습니다.');
});
test('old access records remain valid; invalid and duplicate blocked records fail',()=>{
 validateAccess({mode:'all',users:[]});
 const record={id,note:'',reason:''};
 for(const blockedUsers of [null,[record,record],[{...record,id:'123'}],[{...record,note:'x'.repeat(101)}],[{...record,reason:'x'.repeat(301)}]])assert.throws(()=>validateAccess({mode:'all',users:[],blockedUsers}));
});
