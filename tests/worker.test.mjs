import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const base=process.env.GYEOTE_TEST_URL||'http://127.0.0.1:8901';
const code=(await readFile(new URL('../data/access-code.txt',import.meta.url),'utf8')).trim();
function client(){let cookie='';return async(path,method='GET',body,extra={})=>{const r=await fetch(base+path,{method,headers:{...extra,...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});if(r.headers.has('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return r;};}
test('Cloud worker requires access code; cookie and API privacy headers',async()=>{
 const c=client();assert.equal((await c('/api/session','POST')).status,401);
 const r=await c('/api/session','POST',{access_code:code});assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/HttpOnly/);assert.equal(r.headers.get('cache-control'),'no-store');
 assert.equal((await c('/api/rooms')).status,200);
});
test('Accounts cannot read rooms; forged origins rejected',async()=>{
 const a=client(),b=client();await a('/api/session','POST',{access_code:code});await b('/api/session','POST',{access_code:code});
 const room=(await (await a('/api/rooms')).json())[0].id;
 assert.equal((await b(`/api/rooms/${room}/turns`)).status,404);
 assert.equal((await a('/api/rooms','POST',{}, {Origin:'https://untrusted.example'})).status,403);
});
test('Invalid uploads and profiles rejected before any paid AI call',async()=>{
 const c=client();await c('/api/session','POST',{access_code:code});const room=(await(await c('/api/rooms')).json())[0].id;
 assert.equal((await c('/api/profile','PUT',{name:'나',mode:'unknown'})).status,422);
 assert.equal((await c(`/api/rooms/${room}/turns`,'POST',{request_id:crypto.randomUUID(),text:''})).status,422);
 assert.equal((await c(`/api/rooms/${room}/turns`,'POST',{request_id:crypto.randomUUID(),text:'사진',image:'%%%bad',image_type:'image/jpeg'})).status,422);
});
test('Install assets exist and advertise standalone mode',async()=>{
 const manifest=await (await fetch(base+'/manifest.webmanifest')).json();assert.equal(manifest.display,'standalone');
 for(const icon of manifest.icons){const r=await fetch(base+icon.src);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/image\/png/);}
 const sw=await(await fetch(base+'/sw.js')).text();assert.match(sw,/pathname.startsWith\('\/api\/'\)/);
});
test('Account status is private and logout invalidates the server session',async()=>{
 const c=client();const publicStatus=await c('/api/auth/status');assert.equal(publicStatus.status,200);assert.equal(publicStatus.headers.get('cache-control'),'no-store');assert.equal((await publicStatus.json()).linked,false);
 await c('/api/session','POST',{access_code:code});
 assert.equal((await c('/api/auth/logout','POST',{}, {Origin:'https://untrusted.example'})).status,403);
 assert.equal((await c('/api/rooms')).status,200);
 assert.equal((await c('/api/auth/logout','POST',{all:true})).status,409);
 assert.equal((await c('/api/auth/logout','POST',{})).status,200);
 assert.equal((await c('/api/rooms')).status,401);
});
