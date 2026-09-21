import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const base=process.env.GYEOTE_TEST_URL||'http://localhost:8917';
test('Worker scheduler delivers to a private account once; public callers cannot invoke internal job',async()=>{
 assert.ok(['localhost','127.0.0.1'].includes(new URL(base).hostname),'Use a local Worker with --test-scheduled');
 const access_code=(await readFile(new URL('../data/access-code.txt',import.meta.url),'utf8')).trim();let cookie='';
 async function api(path,method='GET',body){const r=await fetch(base+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(r.headers.has('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];assert.ok(r.ok,`${path}: ${r.status}`);return r.json();}
 await api('/api/session','POST',{access_code});const room=(await api('/api/rooms'))[0].id;
 const a=await api('/api/agenda','POST',{request_id:crypto.randomUUID(),room,kind:'event',title:'예약 알림 검증',starts:new Date(Date.now()+240000).toISOString(),place:'검증 전용'});
 await api(`/api/agenda/${a.id}/reminder`,'PUT',{minutes:5});assert.equal((await api('/api/reminders'))[0].minutes,5);
 const publicCall=await fetch(base+'/reminders',{method:'POST'});assert.equal(publicCall.status===200&&publicCall.headers.get('content-type')?.includes('application/json'),false);
 assert.equal((await api('/api/notices')).length,0);
 for(let i=0;i<2;i++){const r=await fetch(base+'/cdn-cgi/handler/scheduled');assert.equal(r.status,200);}
 const notices=await api('/api/notices');assert.equal(notices.length,1);assert.equal(notices[0].target,a.id);assert.match(notices[0].text,/예약 알림 검증/);
 await api(`/api/agenda/${a.id}/reminder`,'PUT',{minutes:null});assert.equal((await api('/api/reminders')).length,0);
});
