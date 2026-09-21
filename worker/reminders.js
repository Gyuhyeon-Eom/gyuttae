import {access,allowed,CollaborationError} from './collaboration.js';
export const reminderChoices=[5,30,60,1440];
export function initReminders(s){s.run(`CREATE TABLE IF NOT EXISTS reminders(item TEXT NOT NULL,uid TEXT NOT NULL,minutes INTEGER NOT NULL,PRIMARY KEY(item,uid));CREATE TABLE IF NOT EXISTS reminder_deliveries(item TEXT NOT NULL,uid TEXT NOT NULL,due REAL NOT NULL,PRIMARY KEY(item,uid,due));`);}
export function reminderRoute(s,request,uid,b){const path=new URL(request.url).pathname;
 if(path==='/api/reminders'&&request.method==='GET')return Response.json(s.rows('SELECT r.*,a.room FROM reminders r JOIN agenda a ON a.id=r.item WHERE r.uid=?',uid).filter(r=>allowed(s,r.room,uid)),{headers:{'Cache-Control':'no-store'}});
 const match=path.match(/^\/api\/agenda\/([\w-]+)\/reminder$/);if(!match||request.method!=='PUT')return null;
 const item=s.one('SELECT * FROM agenda WHERE id=?',match[1]);if(!item)throw new CollaborationError(404,'약속을 찾지 못했어요.');access(s,item.room,uid);
 if(b.minutes!==null&&!reminderChoices.includes(b.minutes))throw new CollaborationError(422,'알림 시간을 선택해 주세요.');
 if(b.minutes!==null&&(!item.starts||Date.parse(item.starts)<=Date.now()||item.done))throw new CollaborationError(422,'아직 지나지 않은 날짜와 시간을 먼저 정해 주세요.');
 if(b.minutes===null)s.run('DELETE FROM reminders WHERE item=? AND uid=?',item.id,uid);else s.run('INSERT OR REPLACE INTO reminders VALUES(?,?,?)',item.id,uid,b.minutes);
 return Response.json({item:item.id,minutes:b.minutes},{headers:{'Cache-Control':'no-store'}});
}
export function deliverReminders(s,at=Date.now()){
 let delivered=0;
 s.ctx.storage.transactionSync(()=>{
  for(const r of s.rows('SELECT r.*,a.room,a.title,a.starts,a.done FROM reminders r JOIN agenda a ON a.id=r.item WHERE a.starts IS NOT NULL AND a.done=0')){
   const start=Date.parse(r.starts),due=start-r.minutes*60000;
   if(!allowed(s,r.room,r.uid)||!Number.isFinite(start)||due>at||start<=at)continue;
   if(s.one('SELECT item FROM reminder_deliveries WHERE item=? AND uid=? AND due=?',r.item,r.uid,due))continue;
   s.run('INSERT INTO reminder_deliveries VALUES(?,?,?)',r.item,r.uid,due);
   const clock=new Date(start).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'numeric',minute:'2-digit'});
   s.run('INSERT INTO notices VALUES(?,?,?,?,?,?,0)',crypto.randomUUID(),r.uid,r.room,`예정 알림 · ${r.title} (${clock}, 한국 시간)`,r.item,at/1000);delivered++;
  }
 });return delivered;
}
