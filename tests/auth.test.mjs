import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {generateKeyPair,SignJWT} from 'jose';
import {initAuth,authRoute,account,verifyGoogleToken} from '../worker/auth.js';
const base='https://app.example';
function store(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,mode TEXT);CREATE TABLE rooms(id TEXT PRIMARY KEY,uid TEXT,title TEXT,created REAL);CREATE TABLE sessions(token TEXT PRIMARY KEY,uid TEXT,expires REAL);CREATE TABLE pairing(code TEXT,uid TEXT,expires REAL);`);
 const s={env:{GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'test-secret',ACCESS_CODE:'123456789012'},run(q,...p){if(!p.length)db.exec(q);else db.prepare(q).run(...p);},one(q,...p){return db.prepare(q).get(...p);},limit(){},ctx:{storage:{transactionSync(fn){db.exec('BEGIN');try{fn();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}}},async sessionHeader(uid){db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(crypto.randomUUID(),uid,Date.now()/1000+3600);return 'gyeote_session=new; Path=/; HttpOnly; Secure; SameSite=Strict';}};
 initAuth(s);return s;
}
function user(s,id='guest',token='session'){
 s.run("INSERT INTO users VALUES(?,'나','easy')",id);s.run('INSERT INTO rooms VALUES(?,?,?,?)','room-'+id,id,'기존 대화',0);s.run('INSERT INTO sessions VALUES(?,?,?)',token,id,Date.now()/1000+3600);
}
async function begin(s,uid,token='session',body={}){
 const r=await authRoute(s,new Request(base+'/api/auth/google/start',{method:'POST'}),{uid,token,b:body,ip:'test'});
 assert.equal(r.status,200);const url=new URL((await r.json()).url);
 assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('scope'),'openid email');assert.match(r.headers.get('set-cookie'),/SameSite=Lax/);
 return {state:url.searchParams.get('state'),cookie:r.headers.get('set-cookie').split(';')[0]};
}
async function finish(s,flow,subject='google-user',cookie=flow.cookie){return authRoute(s,new Request(base+'/api/auth/google/callback?code=test-code&state='+flow.state,{headers:{cookie}}),{b:{},token:'',ip:'test'},async()=>({subject,email:subject+'@example.com'}));}
test('Google connects existing history, rotates session and restores the same account on a new device',async()=>{
 const s=store();user(s);const r=await finish(s,await begin(s,'guest'));
 assert.equal(r.headers.get('location'),'/#auth=success');assert.equal(s.one('SELECT uid FROM rooms').uid,'guest');assert.equal(s.one("SELECT * FROM sessions WHERE token='session'"),undefined);assert.equal(account(s,'guest').linked,true);
 const again=await finish(s,await begin(s,null));assert.equal(again.headers.get('location'),'/#auth=success');assert.equal(s.one('SELECT count(*) AS n FROM users').n,1);
});
test('state binding, expiration and one-time consumption reject replay and stolen callbacks',async()=>{
 const s=store();user(s);const f=await begin(s,'guest');
 assert.equal((await finish(s,f,'google-user','gyeote_oauth=wrong')).headers.get('location'),'/#auth=expired');
 assert.equal((await finish(s,f)).headers.get('location'),'/#auth=success');
 assert.equal((await finish(s,f)).headers.get('location'),'/#auth=expired');
 const expired=await begin(s,null);s.run('UPDATE oauth_flows SET expires=0');assert.equal((await finish(s,expired)).headers.get('location'),'/#auth=expired');
});
test('new accounts require an invitation and existing Google accounts cannot overwrite another user',async()=>{
 const s=store();assert.equal((await finish(s,await begin(s,null))).headers.get('location'),'/#auth=invite');assert.equal(s.one('SELECT count(*) AS n FROM users').n,0);
 assert.equal((await finish(s,await begin(s,null,'',{access_code:s.env.ACCESS_CODE}))).headers.get('location'),'/#auth=success');
 user(s);assert.equal((await finish(s,await begin(s,'guest'))).headers.get('location'),'/#auth=conflict');assert.equal(s.one("SELECT uid FROM rooms WHERE id='room-guest'").uid,'guest');
});
test('logout all revokes sessions, pairing codes and pending login links',async()=>{
 const s=store();user(s);await finish(s,await begin(s,'guest'));s.run('INSERT INTO sessions VALUES(?,?,?)','second','guest',Date.now()/1000+3600);s.run("INSERT INTO pairing VALUES('pair','guest',9999999999)");await begin(s,'guest','second');
 const r=await authRoute(s,new Request(base+'/api/auth/logout',{method:'POST'}),{uid:'guest',token:'second',b:{all:true},ip:'test'});
 assert.equal(r.status,200);for(const table of ['sessions','pairing','oauth_flows'])assert.equal(s.one(`SELECT count(*) AS n FROM ${table}`).n,0);assert.equal(account(s,'guest').linked,true);
});
test('revoked session cannot be linked by callback; failed exchange does not create identity',async()=>{
 const s=store();user(s);const f=await begin(s,'guest');s.run('DELETE FROM sessions');assert.equal((await finish(s,f)).headers.get('location'),'/#auth=expired');assert.equal(account(s,'guest').linked,false);
 const next=await begin(s,null);const r=await authRoute(s,new Request(base+'/api/auth/google/callback?code=test&state='+next.state,{headers:{cookie:next.cookie}}),{b:{},ip:'test'},async()=>{throw new Error('invalid token');});assert.equal(r.headers.get('location'),'/#auth=failed');
});
test('ID tokens require Google issuer, intended audience, valid signature, nonce, expiry and verified email',async()=>{
 const pair=await generateKeyPair('RS256'),other=await generateKeyPair('RS256');
 const sign=async(overrides={},key=pair.privateKey)=>new SignJWT({nonce:'nonce',email:'me@example.com',email_verified:true,...overrides}).setProtectedHeader({alg:'RS256'}).setIssuer(overrides.iss||'https://accounts.google.com').setAudience(overrides.aud||'client').setSubject('subject').setIssuedAt().setExpirationTime(overrides.exp||'5m').sign(key);
 assert.equal((await verifyGoogleToken(await sign(),'nonce','client',pair.publicKey)).subject,'subject');
 for(const bad of [{iss:'https://evil.example'},{aud:'other'},{nonce:'wrong'},{email_verified:false},{exp:1},{azp:'other'}])await assert.rejects(verifyGoogleToken(await sign(bad),'nonce','client',pair.publicKey));
 await assert.rejects(verifyGoogleToken(await sign({},other.privateKey),'nonce','client',pair.publicKey));
});
