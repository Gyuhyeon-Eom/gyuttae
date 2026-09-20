import { DurableObject } from 'cloudflare:workers';
import AI from './ai-config.json';
import {initCollaboration,collaborationRoute,CollaborationError,access,listRooms,notify,roomMembers,proposeFromText} from './collaboration.js';
import {initAuth, authRoute, account} from './auth.js';

const json=(v,status=200,headers={})=>Response.json(v,{status,headers:{'Cache-Control':'no-store',...headers}});
const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),v=>v.toString(16).padStart(2,'0')).join('');
const random=()=>crypto.randomUUID();
const now=()=>Date.now()/1000;
const MODES=['easy','guided','expert'];
class Problem extends Error {constructor(status,message){super(message);this.status=status;}}
const need=(ok,status,message)=>{if(!ok)throw new Problem(status,message);};
const short=(s,max)=>typeof s==='string'&&s.length<=max;
const secureEqual=(a,b)=>{if(!a||!b||a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;};
function checkAnswer(a){
  need(a&&short(a.summary,6000)&&a.summary.trim()&&short(a.voice,6000),502,'答');
  for(const k of ['facts','steps','suggestions'])need(Array.isArray(a[k])&&a[k].length<=12,502,'答');
  for(const f of a.facts)need(short(f.label,1000)&&short(f.value,6000),502,'答');
  for(const s of a.steps)need(short(s.action,1000)&&short(s.detail,6000)&&short(s.question,3000),502,'答');
  for(const s of a.suggestions)need(short(s,3000),502,'答');
  for(const k of ['goal','question','caution'])need(a[k]===null||short(a[k],6000),502,'答');
  return a;
}
async function body(request){
  const reader=request.body?.getReader();if(!reader)return {};
  let count=0;const chunks=[];
  while(true){const {done,value}=await reader.read();if(done)break;count+=value.length;need(count<=3200000,413,'사진이나 문장이 너무 커요.');chunks.push(value);}
  const bytes=new Uint8Array(count);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  try{return JSON.parse(new TextDecoder().decode(bytes)||'{}');}catch{throw new Problem(422,'입력 내용을 확인해 주세요.');}
}
function imageBytes(b){
  if(!b.image)return null;
  need(short(b.image,3000000)&&['image/jpeg','image/png','image/webp'].includes(b.image_type),422,'JPEG·PNG·WebP 사진을 골라 주세요.');
  let raw;try{raw=Uint8Array.from(atob(b.image),c=>c.charCodeAt(0));}catch{throw new Problem(422,'사진을 읽지 못했어요.');}
  const jpeg=raw[0]===255&&raw[1]===216&&raw[2]===255;
  const png=[137,80,78,71,13,10,26,10].every((v,i)=>raw[i]===v);
  const webp=new TextDecoder().decode(raw.slice(0,4))==='RIFF'&&new TextDecoder().decode(raw.slice(8,12))==='WEBP';
  need(raw.length<=2097152&&((b.image_type==='image/jpeg'&&jpeg)||(b.image_type==='image/png'&&png)||(b.image_type==='image/webp'&&webp)),422,'2MB 이하의 사진을 선택해 주세요.');
  return raw;
}
function toBase64(bytes){let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);}

export default {
  async fetch(request,env){
    let response;
    const url=new URL(request.url);
    if(url.pathname.startsWith('/api/')){
      if(request.method!=='GET'&&request.headers.has('Origin')&&request.headers.get('Origin')!==url.origin)return json({detail:'현재 앱 화면에서 다시 시도해 주세요.'},403);
      response=await env.CHAT.getByName('personal-pilot-v1').fetch(request);
    }else response=await env.ASSETS.fetch(request);
    response=new Response(response.body,response);
    response.headers.set('X-Content-Type-Options','nosniff');
    response.headers.set('Referrer-Policy','no-referrer');
    response.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    if(['/','/sw.js','/app.js','/manifest.webmanifest'].includes(url.pathname))response.headers.set('Cache-Control','no-cache');
    return response;
  }
};

export class ChatStore extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);this.ctx=ctx;this.env=env;this.sql=ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,mode TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,uid TEXT NOT NULL,expires REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY,uid TEXT NOT NULL,title TEXT NOT NULL,created REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY,uid TEXT NOT NULL,room TEXT NOT NULL,fingerprint TEXT NOT NULL,text TEXT NOT NULL,image BLOB,image_type TEXT,mode TEXT NOT NULL,status TEXT NOT NULL,answer TEXT,error TEXT,usage TEXT,completed INTEGER NOT NULL DEFAULT 0,created REAL NOT NULL,started REAL);
      CREATE TABLE IF NOT EXISTS attempts(uid TEXT NOT NULL,created REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS pairing(code TEXT PRIMARY KEY,uid TEXT NOT NULL,expires REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY,start REAL NOT NULL,count INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS room_turns ON turns(room,created);
      CREATE INDEX IF NOT EXISTS daily_attempts ON attempts(created);
    `);
    initAuth(this);initCollaboration(this);
  }
  rows(q,...p){return this.sql.exec(q,...p).toArray();}
  one(q,...p){return this.rows(q,...p)[0];}
  run(q,...p){this.sql.exec(q,...p);}
  limit(key,cap,window){const t=now(),r=this.one('SELECT * FROM limits WHERE key=?',key);need(!r||r.start<t-window||r.count<cap,429,'요청이 많아요. 잠시 뒤 다시 시도해 주세요.');if(!r||r.start<t-window)this.run('INSERT OR REPLACE INTO limits VALUES(?,?,1)',key,t);else this.run('UPDATE limits SET count=count+1 WHERE key=?',key);}
  room(id,uid){access(this,id,uid);}
  turn(id,uid){const r=this.one('SELECT * FROM turns WHERE id=?',id);need(r,404,'메시지를 찾지 못했어요.');this.room(r.room,uid);return r;}
  view(row,viewer){const {image,fingerprint,uid,usage,started,...r}=row;const group=this.one('SELECT room FROM groups WHERE room=?',row.room);const personalProgress=group?this.one('SELECT completed FROM progress WHERE turn=? AND uid=?',row.id,viewer)?.completed||0:row.completed;return {...r,author_id:uid,author:this.one('SELECT name FROM users WHERE id=?',uid)?.name||'가족',mine:uid===viewer,completed:personalProgress,read_by:group?roomMembers(this,row.room).filter(m=>m.seen>=row.created&&m.id!==uid).map(m=>({id:m.id,name:m.name})):[],proposal:proposeFromText(row.text),has_image:!!image,answer:r.answer?JSON.parse(r.answer):null};}
  async sessionHeader(uid,request){
    const token=random()+random();const h=await hash(token);
    this.run('INSERT INTO sessions VALUES(?,?,?)',h,uid,now()+90*86400);
    return `gyeote_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=7776000${new URL(request.url).protocol==='https:'?'; Secure':''}`;
  }
  reserve(uid){
    need(!this.one("SELECT id FROM turns WHERE uid=? AND status='pending'",uid),409,'이전 답변을 받고 있어요. 잠시만 기다려 주세요.');
    need(this.one("SELECT COUNT(*) AS n FROM turns WHERE status='pending'").n<4,429,'요청이 몰렸어요. 조금 뒤 다시 보내 주세요.');
    need(this.one('SELECT COUNT(*) AS n FROM attempts WHERE created>?',now()-86400).n<Number(this.env.DAILY_LIMIT||100),429,'오늘의 AI 요청 한도에 도달했어요. 내일 다시 이용해 주세요.');
    this.run('INSERT INTO attempts VALUES(?,?)',uid,now());
  }
  async schedule(){if(await this.ctx.storage.getAlarm()===null)await this.ctx.storage.setAlarm(Date.now()+100);}
  async fetch(request){
    try{return await this.route(request);}catch(e){return json({detail:(e instanceof Problem||e instanceof CollaborationError)?e.message:'잠시 처리하지 못했어요. 다시 시도해 주세요.'},(e instanceof Problem||e instanceof CollaborationError)?e.status:500);}
  }
  async route(request){
    const url=new URL(request.url),path=url.pathname,method=request.method;
    const cookie=(request.headers.get('cookie')||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('gyeote_session='))?.slice(15)||'';
    const token=await hash(cookie);
    let uid=this.one('SELECT uid FROM sessions WHERE token=? AND expires>?',token,now())?.uid;
    const b=method==='GET'?{}:await body(request);
    const ip=request.headers.get('CF-Connecting-IP')||'local';
    if(path.startsWith('/api/auth/')){const response=await authRoute(this,request,{uid,token,b,ip});if(response)return response;}
    if(path==='/api/session'&&method==='POST'){
      let headers={};
      if(!uid){
        need(this.env.ACCESS_CODE,503,'앱 접속 설정을 준비하고 있어요.');
        if(b.access_code)this.limit('access:'+ip,8,600);
        need(secureEqual(b.access_code,this.env.ACCESS_CODE),401,'처음 연결할 때는 접속 코드가 필요해요.');
        this.limit('signup:'+ip,12,3600);uid=random();
        this.run("INSERT INTO users VALUES(?,'나','easy')",uid);
        this.run('INSERT INTO rooms VALUES(?,?,?,?)',random(),uid,'첫 대화',now());
        headers={'Set-Cookie':await this.sessionHeader(uid,request)};
      }
      return json({uid,account:account(this,uid),profile:this.one('SELECT name,mode FROM users WHERE id=?',uid),ai_ready:!!this.env.ANTHROPIC_API_KEY,access_code:null},200,headers);
    }
    need(uid,401,'기기 연결이 만료됐어요. 새로고침해 주세요.');
    const collaboration=await collaborationRoute(this,request,{uid,b,token});if(collaboration)return collaboration;
    if(path==='/api/profile'&&method==='PUT'){
      need(short(b.name,20)&&b.name.trim()&&MODES.includes(b.mode),422,'안내 방식을 확인해 주세요.');
      this.run('UPDATE users SET name=?,mode=? WHERE id=?',b.name.trim(),b.mode,uid);return json({name:b.name.trim(),mode:b.mode});
    }
    if(path==='/api/rooms'){
      if(method==='GET')return json(listRooms(this,uid));
      if(method==='POST'){this.limit('room:'+uid,20,3600);const id=random();this.run('INSERT INTO rooms VALUES(?,?,?,?)',id,uid,'새 대화',now());return json({id,title:'새 대화'});}
    }
    const roomMatch=path.match(/^\/api\/rooms\/([a-zA-Z0-9-]+)\/turns$/);
    if(roomMatch){
      const room=roomMatch[1];this.room(room,uid);
      if(method==='GET')return json(this.rows('SELECT * FROM (SELECT * FROM turns WHERE room=? ORDER BY created DESC LIMIT 200) ORDER BY created',room).map(r=>this.view(r,uid)));
      if(method==='POST'){
        need(short(b.request_id,80)&&/^[a-zA-Z0-9-]{16,80}$/.test(b.request_id)&&short(b.text??'',6000),422,'입력 내용을 확인해 주세요.');
        const text=(b.text||'').trim();need(text||b.image,422,'문장이나 사진을 보내 주세요.');
        const bytes=imageBytes(b), fingerprint=await hash(JSON.stringify([room,text,b.image_type||null,b.image||null,b.ask_ai===true]));
        const exists=this.one('SELECT * FROM turns WHERE id=?',b.request_id);
        if(exists){need(exists.uid===uid&&exists.fingerprint===fingerprint,409,'요청 식별자가 다른 메시지와 겹쳤어요.');return json(this.view(exists,uid),202);}
        const group=this.one('SELECT room FROM groups WHERE room=?',room);
        const wantsAI=!group||b.ask_ai===true;
        this.ctx.storage.transactionSync(()=>{
          if(wantsAI)this.reserve(uid);else this.limit('message:'+uid,60,60);
          const mode=this.one('SELECT mode FROM users WHERE id=?',uid).mode;
          this.run('INSERT INTO turns(id,uid,room,fingerprint,text,image,image_type,mode,status,created) VALUES(?,?,?,?,?,?,?,?,?,?)',b.request_id,uid,room,fingerprint,text,bytes?.buffer||null,b.image_type||null,mode,wantsAI?'pending':'message',now());
          this.run("UPDATE rooms SET title=? WHERE id=? AND title IN ('새 대화','첫 대화')",(text||'사진에 대해 물어봤어요').slice(0,26),room);
        });
        if(group)notify(this,room,uid,'가족방에 새 메시지가 왔어요.',b.request_id);
        if(wantsAI)await this.schedule();return json(this.view(this.turn(b.request_id,uid),uid),202);
      }
    }
    const turnMatch=path.match(/^\/api\/turns\/([a-zA-Z0-9-]+)(?:\/(image|retry|progress))?$/);
    if(turnMatch){
      const id=turnMatch[1],action=turnMatch[2],t=this.turn(id,uid);
      if(method==='GET'&&!action)return json(this.view(t,uid));
      if(method==='GET'&&action==='image'){need(t.image,404,'사진이 없어요.');return new Response(t.image,{headers:{'Content-Type':t.image_type,'Cache-Control':'no-store'}});}
      if(method==='PUT'&&action==='progress'){
        need(t.answer&&Number.isInteger(b.completed)&&b.completed>=0&&b.completed<=JSON.parse(t.answer).steps.length,422,'단계를 확인해 주세요.');
        const shared=this.one('SELECT room FROM groups WHERE room=?',t.room);const previous=shared?this.one('SELECT completed FROM progress WHERE turn=? AND uid=?',id,uid)?.completed||0:t.completed;const n=Math.max(previous,b.completed);if(shared)this.run('INSERT OR REPLACE INTO progress VALUES(?,?,?)',id,uid,n);else this.run('UPDATE turns SET completed=? WHERE id=?',n,id);return json({completed:n});
      }
      if(method==='POST'&&action==='retry'){
        need(t.uid===uid,403,'질문한 사람만 다시 요청할 수 있어요.');
        if(t.status!=='failed')return json(this.view(t,uid),202);
        this.ctx.storage.transactionSync(()=>{this.reserve(uid);this.run("UPDATE turns SET status='pending',error=NULL,started=NULL WHERE id=?",id);});
        await this.schedule();return json(this.view(this.turn(id,uid),uid),202);
      }
    }
    if(path==='/api/pairing'&&method==='POST'){
      this.limit('pairing:'+uid,10,3600);
      const code=Array.from(crypto.getRandomValues(new Uint8Array(8)),n=>String(n%10)).join('');
      const h=await hash(code);this.run('DELETE FROM pairing WHERE uid=? OR expires<?',uid,now());this.run('INSERT INTO pairing VALUES(?,?,?)',h,uid,now()+600);return json({code,expires_in:600});
    }
    if(path==='/api/pairing/claim'&&method==='POST'){
      need(/^\d{8}$/.test(b.code||''),422,'8자리 코드를 입력해 주세요.');this.limit('claim:'+ip,5,600);
      const h=await hash(b.code),pair=this.one('SELECT * FROM pairing WHERE code=? AND expires>?',h,now());
      need(pair,400,'코드를 확인해 주세요. 10분 동안 한 번 쓸 수 있어요.');
      this.run('DELETE FROM pairing WHERE code=?',h);this.run('DELETE FROM sessions WHERE token=?',token);
      return json({ok:true},200,{'Set-Cookie':await this.sessionHeader(pair.uid,request)});
    }
    throw new Problem(404,'찾지 못했어요.');
  }
  async alarm(){
    // A watchdog fails interrupted calls; paid requests are never automatically replayed.
    this.run("UPDATE turns SET status='failed',error='처리가 중단됐어요. 다시 시도해 주세요.' WHERE status='pending' AND started IS NOT NULL AND started<?",now()-85);
    const active=this.one("SELECT id FROM turns WHERE status='pending' AND started IS NOT NULL");
    if(active){await this.ctx.storage.setAlarm(Date.now()+10000);return;}
    const t=this.one("SELECT * FROM turns WHERE status='pending' AND started IS NULL ORDER BY created LIMIT 1");
    if(!t)return;
    this.run('UPDATE turns SET started=? WHERE id=?',now(),t.id);
    await this.ctx.storage.setAlarm(Date.now()+90000);
    try{
      const previous=this.rows("SELECT text,answer FROM turns WHERE room=? AND status IN ('done','message') AND created<? ORDER BY created DESC LIMIT 8",t.room,t.created).reverse();
      const messages=previous.flatMap(r=>[{role:'user',content:r.text.slice(0,4000)||'이전 사진에 대해 질문했어요.'},...(r.answer?[{role:'assistant',content:r.answer.slice(0,6000)}]:[])]);
      const content=[];
      if(t.image)content.push({type:'image',source:{type:'base64',media_type:t.image_type,data:toBase64(new Uint8Array(t.image))}});
      content.push({type:'text',text:t.text||'이 사진을 읽고 무엇을 하면 좋을지 알려주세요.'});messages.push({role:'user',content});
      need(this.env.ANTHROPIC_API_KEY,503,'AI 연결 설정이 필요해요.');
      const response=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':this.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','Content-Type':'application/json'},body:JSON.stringify({model:this.env.MODEL||'claude-sonnet-5',max_tokens:2200,system:AI.system+'\n'+AI.modes[t.mode],messages,output_config:{format:{type:'json_schema',schema:AI.schema}}}),signal:AbortSignal.timeout(75000)});
      need(response.ok,502,response.status===429?'AI 요청이 몰렸어요. 잠시 뒤 다시 시도해 주세요.':'AI 연결을 확인해야 해요. 잠시 뒤 다시 시도해 주세요.');
      const result=await response.json();need(result.stop_reason==='end_turn',502,'답변을 끝까지 받지 못했어요. 다시 시도해 주세요.');
      const answer=checkAnswer(JSON.parse(result.content.filter(x=>x.type==='text').map(x=>x.text).join('')));
      this.run("UPDATE turns SET status='done',answer=?,usage=?,error=NULL WHERE id=?",JSON.stringify(answer),JSON.stringify({model:result.model,...result.usage}),t.id);
    }catch(e){this.run("UPDATE turns SET status='failed',error=? WHERE id=?",e instanceof Problem&&e.message!=='答'?e.message:'AI 연결이 끊겼어요. 대화는 저장했으니 다시 시도해 주세요.',t.id);}
    await this.ctx.storage.setAlarm(Date.now()+100);
  }
}
