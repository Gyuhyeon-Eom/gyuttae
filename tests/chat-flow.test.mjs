import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const flow=vm.runInNewContext(readFileSync(new URL('../static/chat-flow.js',import.meta.url),'utf8')+';ChatFlow');
const turn={id:'first',room:'family',author_id:'mom',created:new Date(2026,8,21,12).getTime()/1000,status:'message'};
const entry=()=>({uid:'me',room:'family',created:turn.created+2,delivery:'sending',body:{request_id:'stable-id',text:'도착했어요',image:'photo-bytes',image_type:'image/jpeg',ask_ai:false}});
test('Group by identity, room, day and gap; stop at AI replies or failed sends',()=>{
 assert.equal(flow.grouped(turn,{...turn,created:turn.created+90}),true);
 for(const change of [{author_id:'dad'},{room:'another'},{created:turn.created+120},{created:turn.created-1},{status:'pending'},{deliveryError:'offline'}])assert.equal(flow.grouped(turn,{...turn,...change}),false);
 assert.equal(flow.grouped({...turn,status:'done'},turn),false);
 const midnight=new Date(2026,8,22).getTime()/1000;
 assert.equal(flow.grouped({...turn,created:midnight-1},{...turn,created:midnight}),false);
});
test('Optimistic messages are room scoped, retain photos and deduplicate server receipts',()=>{
 const e=entry();let rows=flow.merge([turn],[e],'family','나');assert.equal(rows.length,2);assert.match(rows[1].localImage,/photo-bytes/);
 rows=flow.merge([turn,{...turn,id:e.body.request_id}],[e],'family','나');assert.equal(rows.length,2);
 assert.equal(flow.merge([], [e], 'other','나').length,0);
});
test('Failed retries preserve original payload and are never automatically replayed',async()=>{
 let calls=0;const e=entry();let accepted;
 const q=new flow.Queue({send:async sent=>{assert.equal(sent,e);assert.equal(sent.body.request_id,'stable-id');assert.equal(sent.body.image,'photo-bytes');if(++calls===1)throw Error('offline');return {id:'stable-id',room:'family'};},changed:()=>{},accepted:t=>accepted=t});
 q.add(e);await q.retry('stable-id');assert.equal(e.delivery,'failed');assert.equal(q.entries.length,1);assert.equal(calls,1);
 await q.retry('stable-id');assert.equal(calls,2);assert.equal(q.entries.length,0);assert.equal(accepted.id,'stable-id');
});
test('Double retry clicks send once and poll confirmation cannot be reverted by a late failure',async()=>{
 let reject,calls=0;const e=entry();const q=new flow.Queue({send:()=>{calls++;return new Promise((_,r)=>reject=r);},changed:()=>{},accepted:()=>{}});
 q.add(e);const pending=q.retry('stable-id');await q.retry('stable-id');assert.equal(calls,1);
 q.confirm([{id:'stable-id'}]);reject(Error('response lost'));await pending;assert.equal(q.entries.length,0);
});
test('One failed message does not overwrite another pending message',async()=>{
 const first=entry(),second={...entry(),body:{...entry().body,request_id:'second',text:'다음 문장'}};
 const q=new flow.Queue({send:async e=>{if(e===first)throw Error('offline');return{id:e.body.request_id};},changed:()=>{},accepted:()=>{}});
 q.add(first);q.add(second);await Promise.all([q.retry('stable-id'),q.retry('second')]);assert.equal(q.entries.length,1);assert.equal(q.entries[0].body.text,'도착했어요');
});
