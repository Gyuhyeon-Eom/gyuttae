const json=(v,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store'}});
const now=()=>Date.now()/1000,id=()=>crypto.randomUUID();
const digest=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),n=>n.toString(16).padStart(2,'0')).join('');
export class CollaborationError extends Error{constructor(status,message){super(message);this.status=status;}}
const need=(yes,status,message)=>{if(!yes)throw new CollaborationError(status,message);};
const str=(s,n)=>typeof s==='string'&&s.trim().length>0&&s.length<=n;
export function initCollaboration(s){s.run(`
CREATE TABLE IF NOT EXISTS groups(room TEXT PRIMARY KEY,owner TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members(room TEXT NOT NULL,uid TEXT NOT NULL,seen REAL NOT NULL DEFAULT 0,PRIMARY KEY(room,uid));
CREATE TABLE IF NOT EXISTS invitations(code TEXT PRIMARY KEY,room TEXT NOT NULL,expires REAL NOT NULL,used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS progress(turn TEXT NOT NULL,uid TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(turn,uid));
CREATE TABLE IF NOT EXISTS preferences(uid TEXT PRIMARY KEY,font TEXT NOT NULL DEFAULT 'normal',speech REAL NOT NULL DEFAULT 0.9);
CREATE TABLE IF NOT EXISTS agenda(id TEXT PRIMARY KEY,room TEXT NOT NULL,creator TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,starts TEXT,place TEXT NOT NULL,assignee TEXT,accepted INTEGER NOT NULL DEFAULT 0,done INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,source TEXT,parent TEXT,offset INTEGER,created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS confirmations(item TEXT NOT NULL,uid TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(item,uid));
CREATE TABLE IF NOT EXISTS changes(id TEXT PRIMARY KEY,item TEXT NOT NULL,actor TEXT NOT NULL,base INTEGER NOT NULL,patch TEXT NOT NULL,status TEXT NOT NULL,created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS agenda_history(id TEXT PRIMARY KEY,item TEXT NOT NULL,actor TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL,created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS help_requests(id TEXT PRIMARY KEY,room TEXT NOT NULL,uid TEXT NOT NULL,title TEXT NOT NULL,source TEXT,status TEXT NOT NULL,created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY,uid TEXT NOT NULL,room TEXT NOT NULL,text TEXT NOT NULL,target TEXT,created REAL NOT NULL,seen INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS member_user ON members(uid);
CREATE INDEX IF NOT EXISTS agenda_room ON agenda(room);
CREATE INDEX IF NOT EXISTS notice_user ON notices(uid,created);
`);}
export function allowed(s,room,uid){return s.one('SELECT id FROM rooms WHERE id=? AND uid=?',room,uid)||s.one('SELECT room FROM members WHERE room=? AND uid=?',room,uid);}
export function access(s,room,uid){need(allowed(s,room,uid),404,'대화를 찾지 못했어요.');}
export function roomMembers(s,room){return s.rows('SELECT u.id,u.name,u.mode,m.seen FROM members m JOIN users u ON u.id=m.uid WHERE m.room=?',room);}
export function notify(s,room,actor,text,target){for(const u of roomMembers(s,room))if(u.id!==actor)s.run('INSERT INTO notices VALUES(?,?,?,?,?,?,0)',id(),u.id,room,text,target||null,now());}
export function listRooms(s,uid){return s.rows(`SELECT r.*,CASE WHEN g.room IS NULL THEN 'personal' ELSE 'family' END AS kind,
 (SELECT text FROM turns WHERE room=r.id ORDER BY created DESC LIMIT 1) AS preview,
 COALESCE((SELECT MAX(created) FROM turns WHERE room=r.id),r.created) AS updated,
 (SELECT count(*) FROM turns t WHERE t.room=r.id AND t.uid<>? AND t.created>COALESCE((SELECT seen FROM members WHERE room=r.id AND uid=?),0)) AS unread
 FROM rooms r LEFT JOIN groups g ON g.room=r.id WHERE r.uid=? OR EXISTS(SELECT 1 FROM members WHERE room=r.id AND uid=?) ORDER BY updated DESC`,uid,uid,uid,uid).map(r=>({...r,members:r.kind==='family'?roomMembers(s,r.id):[]}));}
export function agendaView(s,a){return {...a,room_title:s.one('SELECT title FROM rooms WHERE id=?',a.room)?.title,assignee_name:a.assignee?s.one('SELECT name FROM users WHERE id=?',a.assignee)?.name:null,confirmations:s.rows('SELECT c.uid,u.name FROM confirmations c JOIN users u ON u.id=c.uid WHERE c.item=? AND c.version=?',a.id,a.version),changes:s.rows("SELECT * FROM changes WHERE item=? AND status='pending' ORDER BY created",a.id).map(c=>({...c,patch:JSON.parse(c.patch)}))};}
function fields(b){need(['event','task'].includes(b.kind)&&str(b.title,160)&&typeof(b.place||'')==='string'&&(b.place||'').length<=300,422,'제목과 종류를 확인해 주세요.');if(b.starts)need(typeof b.starts==='string'&&b.starts.length<40&&Number.isFinite(Date.parse(b.starts)),422,'날짜와 시간을 확인해 주세요.');return {kind:b.kind,title:b.title.trim(),starts:b.starts?new Date(b.starts).toISOString():null,place:b.place||''};}
export function proposeFromText(text){
 // Only propose literal content. A person selects the exact date and approves it.
 const time=text.match(/(?:(오전|오후)\s*)?(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/);
 const event=/만나|모임|출발|예약|약속|방문/.test(text),task=/챙|준비|확인|담당|가져|해야/.test(text);
 if(!event&&!task)return null;
 let clock=null;if(time){let h=Number(time[2]),m=Number(time[3]||0);if(time[1]==='오후'&&h<12)h+=12;if(time[1]==='오전'&&h===12)h=0;if(h<24&&m<60)clock=`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;}
 return {kind:event?'event':'task',title:text.slice(0,120),time:clock,date:null,note:'대화에서 찾은 후보예요. 날짜·장소·담당자를 확인한 뒤 저장해 주세요.'};
}
export async function collaborationRoute(s,request,{uid,b,token}){
 const url=new URL(request.url),path=url.pathname,method=request.method;
 if(path==='/api/preferences'){
  if(method==='GET')return json(s.one('SELECT font,speech FROM preferences WHERE uid=?',uid)||{font:'normal',speech:.9});
  if(method==='PUT'){need(['normal','large','larger'].includes(b.font)&&[.7,.9,1,1.1].includes(b.speech),422,'글씨와 읽기 속도를 확인해 주세요.');s.run('INSERT OR REPLACE INTO preferences VALUES(?,?,?)',uid,b.font,b.speech);return json({font:b.font,speech:b.speech});}
 }
 if(path==='/api/groups'&&method==='POST'){
  need(str(b.title,60),422,'가족방 이름을 입력해 주세요.');s.limit('group:'+uid,10,3600);const room=id();s.ctx.storage.transactionSync(()=>{s.run('INSERT INTO rooms VALUES(?,?,?,?)',room,uid,b.title.trim(),now());s.run('INSERT INTO groups VALUES(?,?)',room,uid);s.run('INSERT INTO members VALUES(?,?,0)',room,uid);});return json({id:room,title:b.title.trim()},201);
 }
 if(path==='/api/invitations/claim'&&method==='POST'){
  need(str(b.code,100),422,'초대 코드를 입력해 주세요.');s.limit('invite-claim:'+uid,10,600);const h=await digest(b.code.trim());const v=s.one('SELECT * FROM invitations WHERE code=? AND expires>? AND used=0',h,now());need(v,400,'초대가 만료되었거나 이미 사용됐어요.');
  s.ctx.storage.transactionSync(()=>{s.run('INSERT OR IGNORE INTO members VALUES(?,?,0)',v.room,uid);s.run('UPDATE invitations SET used=1 WHERE code=?',h);notify(s,v.room,uid,'새 가족이 방에 참여했어요.',v.room);});return json({room:v.room});
 }
 const roomPath=path.match(/^\/api\/rooms\/([\w-]+)\/(members|invite|seen|leave)$/);
 if(roomPath){const room=roomPath[1],action=roomPath[2];access(s,room,uid);const group=s.one('SELECT * FROM groups WHERE room=?',room);
  if(action==='members'&&method==='GET')return json(group?roomMembers(s,room):[{id:uid,...s.one('SELECT name,mode FROM users WHERE id=?',uid)}]);
  if(action==='seen'&&method==='POST'){s.run('UPDATE members SET seen=? WHERE room=? AND uid=?',now(),room,uid);return json({ok:true});}
  need(group,422,'가족방에서 이용해 주세요.');
  if(action==='invite'&&method==='POST'){need(group.owner===uid,403,'방장만 초대할 수 있어요.');s.limit('invite:'+uid,20,3600);const code=id();const h=await digest(code);s.run('INSERT INTO invitations VALUES(?,?,?,0)',h,room,now()+86400);return json({code,expires_in:86400});}
  if(action==='invite'&&method==='DELETE'){need(group.owner===uid,403,'방장만 취소할 수 있어요.');s.run('UPDATE invitations SET used=1 WHERE room=?',room);return json({ok:true});}
  if(action==='leave'&&method==='POST'){need(group.owner!==uid,409,'방장은 현재 방을 나갈 수 없어요.');s.run('DELETE FROM members WHERE room=? AND uid=?',room,uid);return json({ok:true});}
 }
 if(path==='/api/agenda'&&method==='GET')return json(s.rows('SELECT * FROM agenda ORDER BY done,starts,created').filter(a=>allowed(s,a.room,uid)).map(a=>agendaView(s,a)));
 if(path==='/api/agenda'&&method==='POST'){
  access(s,b.room,uid);s.limit('agenda:'+uid,40,3600);const f=fields(b);need(str(b.request_id,80)&&/^[\w-]{16,80}$/.test(b.request_id),422,'요청 번호를 확인해 주세요.');
  const previous=s.one('SELECT * FROM agenda WHERE id=?',b.request_id);if(previous){need(previous.creator===uid&&previous.room===b.room,409,'이미 사용된 요청이에요.');return json(agendaView(s,previous));}
  if(b.source){const t=s.one('SELECT id FROM turns WHERE id=? AND room=?',b.source,b.room);need(t,422,'원래 메시지를 찾지 못했어요.');}
  if(b.assignee)need(allowed(s,b.room,b.assignee),422,'같은 방의 담당자를 골라 주세요.');
  let starts=f.starts,parent=null,offset=null;if(b.parent){const p=s.one("SELECT * FROM agenda WHERE id=? AND room=? AND kind='event'",b.parent,b.room);need(p?.starts&&Number.isInteger(b.offset)&&Math.abs(b.offset)<=10080,422,'연결할 약속과 시간 차이를 확인해 주세요.');parent=p.id;offset=b.offset;starts=new Date(Date.parse(p.starts)+offset*60000).toISOString();}
  s.run('INSERT INTO agenda VALUES(?,?,?,?,?,?,?,?,?,0,1,?,?,?,?)',b.request_id,b.room,uid,f.kind,f.title,starts,f.place,b.assignee||null,b.assignee===uid?1:0,b.source||null,parent,offset,now());notify(s,b.room,uid,f.kind==='event'?'새 약속이 등록됐어요.':'챙길 일이 등록됐어요.',b.request_id);return json(agendaView(s,s.one('SELECT * FROM agenda WHERE id=?',b.request_id)),201);
 }
 const itemPath=path.match(/^\/api\/agenda\/([\w-]+)(?:\/(confirm|accept|complete|changes|history))?$/);
 if(itemPath){const a=s.one('SELECT * FROM agenda WHERE id=?',itemPath[1]);need(a,404,'항목을 찾지 못했어요.');access(s,a.room,uid);const action=itemPath[2];
  if(action==='history'&&method==='GET')return json(s.rows('SELECT * FROM agenda_history WHERE item=? ORDER BY created DESC',a.id).map(h=>({...h,before:JSON.parse(h.before_json),after:JSON.parse(h.after_json)})));
  if(action==='confirm'&&method==='POST'){need(b.version===a.version,409,'내용이 바뀌었어요. 다시 확인해 주세요.');s.run('INSERT OR REPLACE INTO confirmations VALUES(?,?,?)',a.id,uid,a.version);return json(agendaView(s,a));}
  if(action==='accept'&&method==='POST'){need(a.kind==='task'&&(!a.assignee||a.assignee===uid),403,'본인이 맡은 일만 수락할 수 있어요.');s.run('UPDATE agenda SET assignee=?,accepted=1 WHERE id=?',uid,a.id);notify(s,a.room,uid,'담당자가 할 일을 수락했어요.',a.id);return json(agendaView(s,s.one('SELECT * FROM agenda WHERE id=?',a.id)));}
  if(action==='complete'&&method==='POST'){need(a.kind==='task'&&a.assignee===uid&&a.accepted,403,'할 일을 수락한 담당자만 완료할 수 있어요.');need(typeof b.done==='boolean',422,'완료 상태를 확인해 주세요.');s.run('UPDATE agenda SET done=? WHERE id=?',b.done?1:0,a.id);notify(s,a.room,uid,b.done?'할 일을 완료했어요.':'할 일을 다시 열었어요.',a.id);return json(agendaView(s,s.one('SELECT * FROM agenda WHERE id=?',a.id)));}
  if(action==='changes'&&method==='POST'){need(b.version===a.version,409,'다른 변경이 먼저 적용됐어요. 최신 내용을 확인해 주세요.');const f=fields({...a,...b.patch});need(f.kind===a.kind,422,'종류는 변경할 수 없어요.');need(!a.parent||f.starts===a.starts,422,'연결된 시간은 원래 약속에서 변경해 주세요.');s.limit('change:'+uid,30,3600);const c=id();s.run('INSERT INTO changes VALUES(?,?,?,?,?,?,?)',c,a.id,uid,a.version,JSON.stringify(f),'pending',now());notify(s,a.room,uid,'약속·할 일 변경안이 도착했어요.',a.id);return json({id:c},201);}
 }
 const changePath=path.match(/^\/api\/changes\/([\w-]+)\/(approve|reject)$/);
 if(changePath&&method==='POST'){
  const c=s.one('SELECT * FROM changes WHERE id=?',changePath[1]);need(c,404,'변경안을 찾지 못했어요.');const a=s.one('SELECT * FROM agenda WHERE id=?',c.item);access(s,a.room,uid);const owner=s.one('SELECT owner FROM groups WHERE room=?',a.room)?.owner;
  need(a.creator===uid||owner===uid,403,'작성자나 방장이 변경안을 승인할 수 있어요.');need(c.status==='pending'&&c.base===a.version,409,'이미 처리되었거나 오래된 변경안이에요.');
  s.ctx.storage.transactionSync(()=>{if(changePath[2]==='reject'){s.run("UPDATE changes SET status='rejected' WHERE id=?",c.id);return;}const f=JSON.parse(c.patch);s.run('UPDATE agenda SET title=?,starts=?,place=?,version=version+1 WHERE id=?',f.title,f.starts,f.place,a.id);s.run("UPDATE changes SET status='approved' WHERE id=?",c.id);s.run("UPDATE changes SET status='stale' WHERE item=? AND id<>? AND status='pending'",a.id,c.id);const after=s.one('SELECT * FROM agenda WHERE id=?',a.id);s.run('INSERT INTO agenda_history VALUES(?,?,?,?,?,?)',id(),a.id,uid,JSON.stringify(a),JSON.stringify(after),now());
    for(const child of s.rows('SELECT * FROM agenda WHERE parent=?',a.id)){const next=f.starts?new Date(Date.parse(f.starts)+child.offset*60000).toISOString():null;s.run('UPDATE agenda SET starts=?,version=version+1 WHERE id=?',next,child.id);s.run("UPDATE changes SET status='stale' WHERE item=? AND status='pending'",child.id);s.run('INSERT INTO agenda_history VALUES(?,?,?,?,?,?)',id(),child.id,uid,JSON.stringify(child),JSON.stringify(s.one('SELECT * FROM agenda WHERE id=?',child.id)),now());}
    notify(s,a.room,uid,'변경이 적용됐어요. 약속과 연결된 시간을 다시 확인해 주세요.',a.id);
  });return json({ok:true});
 }
 if(path==='/api/help'&&method==='GET')return json(s.rows('SELECT h.*,u.name,r.title AS room_title FROM help_requests h JOIN users u ON h.uid=u.id JOIN rooms r ON h.room=r.id ORDER BY h.created DESC').filter(h=>allowed(s,h.room,uid)));
 if(path==='/api/help'&&method==='POST'){
  access(s,b.room,uid);need(s.one('SELECT room FROM groups WHERE room=?',b.room),422,'공유할 가족방을 골라 주세요.');need(str(b.title,160)&&str(b.text,3000)&&/^[\w-]{16,80}$/.test(b.request_id||''),422,'공유할 제목과 설명을 입력해 주세요.');
  const old=s.one('SELECT * FROM help_requests WHERE id=?',b.request_id);if(old){need(old.uid===uid&&old.room===b.room,409,'이미 사용된 요청이에요.');return json(old);}
  const source=b.source?s.one('SELECT * FROM turns WHERE id=? AND uid=?',b.source,uid):null;if(b.source)need(source,404,'본인의 질문만 공유할 수 있어요.');
  s.limit('help:'+uid,20,3600);s.ctx.storage.transactionSync(()=>{s.run('INSERT INTO help_requests VALUES(?,?,?,?,?,?,?)',b.request_id,b.room,uid,b.title.trim(),b.source||null,'open',now());s.run("INSERT INTO turns(id,uid,room,fingerprint,text,image,image_type,mode,status,created) VALUES(?,?,?,?,?,?,?,'easy','message',?)",b.request_id,uid,b.room,b.request_id,'도움 요청: '+b.title+'\n'+b.text,b.share_image&&source?.image?source.image:null,b.share_image&&source?.image?source.image_type:null,now());notify(s,b.room,uid,'가족이 도움을 요청했어요.',b.request_id);});return json({id:b.request_id},201);
 }
 const helpPath=path.match(/^\/api\/help\/([\w-]+)\/resolve$/);if(helpPath&&method==='POST'){const h=s.one('SELECT * FROM help_requests WHERE id=?',helpPath[1]);need(h&&h.uid===uid,403,'요청한 사람만 해결 완료로 바꿀 수 있어요.');access(s,h.room,uid);s.run("UPDATE help_requests SET status='resolved' WHERE id=?",h.id);notify(s,h.room,uid,'도움 요청을 해결했어요.',h.id);return json({ok:true});}
 if(path==='/api/notices'&&method==='GET')return json(s.rows('SELECT * FROM notices WHERE uid=? ORDER BY created DESC LIMIT 100',uid).filter(n=>allowed(s,n.room,uid)));
 if(path==='/api/notices/seen'&&method==='POST'){need(Array.isArray(b.ids)&&b.ids.length<=100,422,'알림을 확인해 주세요.');for(const n of b.ids)if(typeof n==='string')s.run('UPDATE notices SET seen=1 WHERE id=? AND uid=?',n,uid);return json({ok:true});}
 return null;
}
