import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const base=process.env.GYEOTE_TEST_URL||'http://localhost:8915';const code=(await readFile(new URL('../data/access-code.txt',import.meta.url),'utf8')).trim();
function client(){let cookie='';return async(path,method='GET',body)=>{const r=await fetch(base+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});if(r.headers.has('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,data:await r.json()};};}
test('Three real sessions: family chat, invitation, agenda, help, privacy and independent preferences',async()=>{
 const a=client(),b=client(),c=client();let identities=[];for(const call of [a,b,c]){const r=await call('/api/session','POST',{access_code:code});assert.equal(r.status,200,JSON.stringify(r.data));identities.push(r.data.uid);}
 await a('/api/profile','PUT',{name:'검증 지은',mode:'expert'});await b('/api/profile','PUT',{name:'검증 엄마',mode:'easy'});
 const group=await a('/api/groups','POST',{title:'검증 가족방'});assert.equal(group.status,201);const room=group.data.id;
 const invite=await a(`/api/rooms/${room}/invite`,'POST',{});assert.equal((await b('/api/invitations/claim','POST',{code:invite.data.code})).status,200);
 assert.equal((await c(`/api/rooms/${room}/turns`)).status,404);
 const turn=await a(`/api/rooms/${room}/turns`,'POST',{request_id:crypto.randomUUID(),text:'토요일 오전 11시에 서울역에서 만나자',ask_ai:false});assert.equal(turn.status,202,JSON.stringify(turn.data));assert.equal(turn.data.status,'message');assert.equal(turn.data.proposal.time,'11:00');
 assert.equal((await b(`/api/rooms/${room}/turns`)).data[0].text,turn.data.text);await b(`/api/rooms/${room}/seen`,'POST',{});assert.equal((await a(`/api/rooms/${room}/turns`)).data[0].read_by.some(u=>u.id===identities[1]),true);
 const event=await a('/api/agenda','POST',{request_id:crypto.randomUUID(),room,kind:'event',title:'서울역 모임',starts:'2026-10-03T02:00:00Z',place:'3번 출구',source:turn.data.id});assert.equal(event.status,201,JSON.stringify(event.data));
 const task=await a('/api/agenda','POST',{request_id:crypto.randomUUID(),room,kind:'task',title:'모자 챙기기',assignee:identities[1]});assert.equal(task.status,201,JSON.stringify(task.data));
 assert.equal((await b(`/api/agenda/${task.data.id}/complete`,'POST',{done:true})).status,403);await b(`/api/agenda/${task.data.id}/accept`,'POST',{});assert.equal((await b(`/api/agenda/${task.data.id}/complete`,'POST',{done:true})).data.done,1);
 const change=await b(`/api/agenda/${event.data.id}/changes`,'POST',{version:1,patch:{starts:'2026-10-03T03:00:00Z'}});assert.equal(change.status,201);assert.equal((await a(`/api/changes/${change.data.id}/approve`,'POST',{})).status,200);assert.equal((await b('/api/agenda')).data.find(x=>x.id===event.data.id).version,2);
 const privateRoom=(await a('/api/rooms')).data.find(r=>r.kind==='personal').id;assert.equal((await b(`/api/rooms/${privateRoom}/turns`)).status,404);
 const help=await a('/api/help','POST',{request_id:crypto.randomUUID(),room,title:'TV 도움',text:'HDMI 선택에서 막혔어요.'});assert.equal(help.status,201);assert.equal((await b('/api/help')).data[0].status,'open');assert.equal((await b(`/api/help/${help.data.id}/resolve`,'POST',{})).status,403);assert.equal((await a(`/api/help/${help.data.id}/resolve`,'POST',{})).status,200);
 await b('/api/preferences','PUT',{font:'larger',speech:.7});assert.equal((await b('/api/preferences')).data.font,'larger');assert.equal((await a('/api/preferences')).data.font,'normal');assert.equal((await b('/api/notices')).data.length>0,true);assert.equal((await c('/api/notices')).data.length,0);
 assert.equal((await b(`/api/rooms/${room}/leave`,'POST',{})).status,200);assert.equal((await b(`/api/turns/${turn.data.id}`)).status,404);assert.equal((await b('/api/agenda')).data.length,0);
});
