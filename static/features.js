'use strict';
const live={detailId:null,reminders:[],agenda:[],help:[],notices:[],preferences:{font:'normal',speech:.9},timer:null,editor:null,helpSource:null,recognition:null};
const when=value=>value?new Date(value).toLocaleString('ko-KR',{month:'long',day:'numeric',weekday:'short',hour:'numeric',minute:'2-digit'}):'시간 미정';
const currentRoom=()=>state.rooms.find(r=>r.id===state.room);
async function loadFeatures(){const [agenda,help,notices,preferences,reminders]=await Promise.all([api('/api/agenda'),api('/api/help'),api('/api/notices'),api('/api/preferences'),api('/api/reminders')]);Object.assign(live,{agenda,help,notices,preferences,reminders});applyPreferences();}
function applyPreferences(){document.documentElement.dataset.font=live.preferences.font;$('#pref-font').value=live.preferences.font;$('#pref-speech').value=String(live.preferences.speech);$('#profile-name').value=state.profile.name;}
async function refreshLive(){const [rooms,agenda,help,notices,reminders]=await Promise.all([api('/api/rooms'),api('/api/agenda'),api('/api/help'),api('/api/notices'),api('/api/reminders')]);const agendaChanged=JSON.stringify(live.agenda)!==JSON.stringify(agenda);state.rooms=rooms;Object.assign(live,{agenda,help,notices,reminders});if(!$('#home-screen').hidden)renderHome();if($('#agenda-panel').open)liveRenderAgendaItems();if($('#agenda-detail').open&&!document.activeElement?.matches('input,select,textarea'))renderAgendaDetail();if(agendaChanged&&!$('#app-frame').hidden)render();}
function startHomePolling(){clearTimeout(live.timer);live.timer=setTimeout(async()=>{if(!state.ready||homeDemo)return;if(!document.hidden)try{await refreshLive();}catch(e){network(e.message);}startHomePolling();},7000);}
async function liveOpenRoom(room){await chooseRoom(room);$('#home-screen').hidden=true;$('#app-frame').hidden=false;document.querySelectorAll('dialog[open]').forEach(d=>d.close());render(true);}
function updateRoomTools(){const group=currentRoom()?.kind==='family';$('.appbar .count').textContent=group?`${currentRoom().members.length}명 참여 중`:'곁에와 나만 보는 대화';$('#room-tools').hidden=false;$('#room-members').hidden=!group;$('#ask-ai').closest('label').hidden=!group;$('#ask-ai').checked=false;$('#message').placeholder=group?'가족에게 이야기를 보내세요':'무엇을 도와드릴까요?';}
function messageActions(t){
 const saved=live.agenda.find(a=>a.source===t.id&&a.room===t.room);
 const suggestion=saved?`<button class="chip ghost saved-agenda" data-open-agenda="${saved.id}">✓ 저장된 ${saved.kind==='event'?'약속':'할 일'} 보기</button>`:t.proposal?`<button class="chip ghost" data-save-agenda="${t.id}">${t.proposal.kind==='event'?'약속으로 저장':'할 일로 저장'}</button>`:'';

 const menu=t.mine!==false?`<details class="message-menu" data-message-menu="${t.id}"><summary aria-label="이 메시지의 추가 기능">더보기</summary><button data-share-help="${t.id}">가족에게 도움 요청</button></details>`:'';
 return suggestion||menu?`<div class="message-actions ${t.status==='message'&&t.mine!==false?'own-message-actions':''}">${suggestion}${menu}</div>`:'';
}
function liveRenderAgenda(){
 const next=live.agenda.filter(a=>a.kind==='event'&&!a.done&&a.starts&&Date.parse(a.starts)>=Date.now()-3600000).sort((a,b)=>Date.parse(a.starts)-Date.parse(b.starts))[0];const remaining=live.agenda.filter(a=>a.kind==='task'&&!a.done).length;
 const date=next?new Date(next.starts):null;
 const today=date?.toDateString()===new Date().toDateString();
 const event=next?{month:`${date.getMonth()+1}월`,day:String(date.getDate()),time:date.toLocaleTimeString('ko-KR',{hour:'numeric',minute:'2-digit'}),title:next.title,place:next.place,room:next.room_title,label:today?'오늘의 약속':date.toLocaleDateString('ko-KR',{weekday:'long'})+' 약속'}:null;
 $('#agenda-summary').innerHTML=homeAgendaCard(event,remaining,'live-next','live-tasks');
 if(next)$('#live-next').onclick=()=>openAgendaDetail(next.id);$('#live-tasks').onclick=()=>openAgenda('tasks');
 const pending=live.help.filter(h=>h.status==='open');$('#home-help-card').hidden=!pending.length;$('#home-help-dot').hidden=!pending.length;
 if(pending.length){$('#home-help-card strong').textContent=`${pending[0].name} 님의 도움 요청`;$('#home-help-card strong+span').textContent=pending[0].title;}
 const unread=live.notices.filter(n=>!n.seen).length;$('#notice-count').textContent=unread>99?'99+':unread;$('#notice-count').hidden=!unread;$('#open-notices').setAttribute('aria-label',unread?`알림함, 새 알림 ${unread}개`:'알림함');
}
function reminderControl(a){const selected=live.reminders.find(r=>r.item===a.id)?.minutes;return `<label class="reminder-control">나에게 미리 알려주기<select data-reminder="${a.id}"><option value="" ${!selected?'selected':''}>알림 끄기</option>${[[5,'5분 전'],[30,'30분 전'],[60,'1시간 전'],[1440,'하루 전']].map(([value,label])=>`<option value="${value}" ${selected===value?'selected':''} ${!a.starts||a.done||Date.parse(a.starts)<=Date.now()?'disabled':''}>${label}</option>`).join('')}</select><small>내 알림함에 저장돼요. 휴대폰 푸시는 아직 지원하지 않아요.</small></label>`;}
function liveRenderAgendaItems(){
 const events=agendaTab==='events';$('#agenda-events').setAttribute('aria-pressed',String(events));$('#agenda-todos').setAttribute('aria-pressed',String(!events));$('#agenda-demo-note').hidden=true;$('#agenda-description').textContent='대화에서 저장한 약속과 할 일이에요.';
 const rows=live.agenda.filter(a=>a.kind===(events?'event':'task'));
 $('#agenda-items').innerHTML=`<button class="chip ghost block" id="live-agenda-add">＋ ${events?'약속':'할 일'} 추가</button>`+(rows.length?rows.map(a=>`<button class="agenda-list-row" data-open-agenda="${a.id}"><span class="agenda-list-date">${a.starts?new Date(a.starts).toLocaleDateString('ko-KR',{month:'numeric',day:'numeric'}):'날짜 미정'}</span><span><strong>${esc(a.title)}</strong><small>${esc(a.starts?new Date(a.starts).toLocaleTimeString('ko-KR',{hour:'numeric',minute:'2-digit'}):'시간 미정')} · ${esc(a.room_title)}</small>${a.changes.length?'<em>변경 제안 확인</em>':a.version>1?'<em>변경된 약속</em>':a.done?'<em>완료</em>':''}</span><span aria-hidden="true">›</span></button>`).join(''):'<p class="agenda-empty">아직 저장된 항목이 없어요.</p>');
 $('#live-agenda-add').onclick=()=>{if(!state.room){toast('대화방을 먼저 만들어 주세요.');return;}openItemEditor(null,null,events?'event':'task');};
}
async function openAgendaDetail(id){
 const a=await api(`/api/agenda/${id}`);live.agenda=live.agenda.filter(x=>x.id!==id).concat(a);if(live.detailId!==id)$('#agenda-detail-content').innerHTML='';live.detailId=id;agendaTab=a.kind==='event'?'events':'tasks';renderAgendaDetail();showDialog('#agenda-detail');
}
function changeLines(before,after){return [['title','제목',x=>x||'미정'],['starts','시간',when],['place','장소',x=>x||'미정']].filter(([key])=>before[key]!==after[key]).map(([key,label,format])=>`<p><small>${label}</small><del>${esc(format(before[key]))}</del><strong>${esc(format(after[key]))}</strong></p>`).join('');}
function renderAgendaDetail(){
 const expanded=$('#agenda-detail-content .detail-options')?.open;
 const a=live.agenda.find(x=>x.id===live.detailId);if(!a){$('#agenda-detail-content').innerHTML='<p class="agenda-empty">이 약속을 더 이상 볼 수 없어요.</p>';return;}
 const room=state.rooms.find(r=>r.id===a.room),members=room?.kind==='family'?room.members:[{id:state.uid,name:state.profile.name}],confirmed=a.confirmations.some(c=>c.uid===state.uid),canApprove=a.creator===state.uid||room?.uid===state.uid;
 const taskAction=a.kind==='task'&&!a.done&&(!a.assignee||a.assignee===state.uid)?`<button class="chip primary block" data-item-action="${a.accepted?'complete':'accept'}" data-id="${a.id}">${a.accepted?'완료했어요':'제가 할게요'}</button>`:a.kind==='task'&&a.done&&a.assignee===state.uid?`<button class="chip ghost" data-item-action="complete" data-id="${a.id}">다시 열기</button>`:'';
 $('#agenda-detail-content').innerHTML=`<p class="detail-room">${esc(a.room_title)} · ${a.kind==='event'?'약속':a.done?'완료한 일':'챙길 일'}</p><h2>${esc(a.title)}</h2><dl class="detail-facts"><div><dt>언제</dt><dd>${esc(when(a.starts))}</dd></div><div><dt>어디서</dt><dd>${esc(a.place||'아직 정하지 않았어요')}</dd></div>${a.kind==='task'?`<div><dt>담당</dt><dd>${esc(a.assignee_name||'아직 정하지 않았어요')}${a.assignee?` · ${a.accepted?'수락함':'수락 대기'}`:''}</dd></div>`:''}</dl>
 ${a.latest_change?`<section class="detail-change"><b>변경된 내용</b>${changeLines(a.latest_change.before,a.latest_change.after)}<small>${esc(a.latest_change.actor_name||'가족')} · ${esc(when(new Date(a.latest_change.created*1000).toISOString()))}</small></section>`:''}
 <section class="detail-people"><h3>현재 내용 확인 <span>${a.confirmations.filter(c=>members.some(m=>m.id===c.uid)).length}/${members.length}</span></h3><p>대화를 읽었는지와 별도로 기록해요.</p><div>${members.map(m=>{const yes=a.confirmations.some(c=>c.uid===m.id);return `<span class="person-confirmation ${yes?'confirmed':''}"><i aria-hidden="true">${esc(m.name.slice(0,1))}</i>${esc(m.name)}${m.id===state.uid&&m.name!=='나'?' (나)':''}<small>${yes?'✓ 확인':'확인 전'}</small></span>`;}).join('')}</div></section>
 ${taskAction}<button class="chip ${taskAction?'ghost':'primary'} block" data-item-action="confirm" data-id="${a.id}" ${confirmed?'disabled':''}>${confirmed?'현재 내용 확인했어요':a.version>1?'바뀐 내용 확인했어요':'내용 확인했어요'}</button>
 ${a.changes.map(c=>`<section class="detail-change"><b>아직 적용되지 않은 변경 제안</b>${changeLines(a,c.patch)}${canApprove?`<div class="chip-row"><button class="chip primary" data-change="${c.id}" data-decision="approve">변경 승인</button><button class="chip ghost" data-change="${c.id}" data-decision="reject">반려</button></div>`:'<p>작성자나 방장이 확인하고 있어요.</p>'}</section>`).join('')}
 <details class="detail-options"><summary>알림 설정 <span>${live.reminders.some(r=>r.item===a.id)?'설정됨':'꺼짐'}</span></summary>${reminderControl(a)}</details><div class="detail-links"><button data-item-edit="${a.id}">변경 제안</button><button data-item-history="${a.id}">변경 기록</button><button data-live-room="${a.room}">대화방 보기 ›</button></div>`;
 if(expanded)$('#agenda-detail-content .detail-options').open=true;
}

function liveRenderHelp(){const rows=live.help;$('#home-section-title').firstChild.textContent='도움 요청 ';$('#home-room-count').textContent=rows.filter(h=>h.status==='open').length;$('#home-filters').hidden=true;$('#home-new').hidden=true;$('#nav-help').classList.add('selected');$('#nav-chats').classList.remove('selected');$('#home-room-list').innerHTML=rows.length?rows.map(h=>`<article class="agenda-item"><div class="agenda-item-top"><span class="agenda-status">${h.status==='open'?'함께 도와주세요':'해결했어요'}</span><small>${esc(h.room_title)}</small></div><h3>${esc(h.title)}</h3><p>${esc(h.name)} 님의 요청</p><button class="agenda-source" data-live-room="${h.room}">가족방에서 답변하기 ↗</button>${h.uid===state.uid&&h.status==='open'?`<button class="chip primary" data-help-resolve="${h.id}">해결했어요</button>`:''}</article>`).join(''):'<p class="home-empty">도움 요청이 오면 여기에 모여요.<br>개인 대화의 ‘가족에게 도움 요청’을 이용해 보세요.</p>';}
async function openItemEditor(turn=null,item=null,kind=null){
 const saved=turn&&live.agenda.find(a=>a.source===turn.id&&a.room===turn.room);if(saved){await openAgendaDetail(saved.id);return;}
 const room=item?.room||turn?.room||state.room;const members=await api(`/api/rooms/${room}/members`);live.editor={room,source:turn?.id||null,item,request_id:makeId()};
 $('#item-room').innerHTML=state.rooms.map(r=>`<option value="${r.id}">${esc(r.title)}</option>`).join('');$('#item-room').value=room;$('#item-room').disabled=!!(turn||item);
 $('#item-time-hint').hidden=!turn;$('#item-time-hint').textContent=turn?.proposal?.time?`대화에서 ${turn.proposal.time}를 찾았어요. 날짜와 오전·오후를 확인해 주세요.`:'정확한 날짜와 시간을 골라 주세요. 아직 미정이면 둘 다 비워 두세요.';
 $('#item-editor-title').textContent=item?'변경 제안':'대화에서 저장';$('#item-form-error').hidden=true;$('#item-room-field').hidden=!!(turn||item);$('#item-kind-field').hidden=!!(turn||item);$('#item-editor-note').textContent=turn?'대화에서 찾은 내용을 확인해 주세요.':item?'승인되면 함께 보는 내용이 바뀌어요.':'약속이나 할 일을 적어 주세요.';$('#item-kind').value=item?.kind||kind||turn?.proposal?.kind||'event';$('#item-kind').disabled=!!item;
 $('#item-title').value=item?.title||turn?.proposal?.title||'';$('#item-source-text').hidden=!turn;$('#item-source-text').textContent=turn?.text||'';
 const date=item?.starts?new Date(Date.parse(item.starts)-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16):'';$('#item-date').value=date.slice(0,10);$('#item-time').value=date.slice(11,16)||turn?.proposal?.time||'';$('#item-place').value=item?.place||turn?.proposal?.place||'';
 $('#item-assignee').innerHTML='<option value="">아직 정하지 않음</option>'+members.map(m=>`<option value="${m.id}">${esc(m.name)}${m.id===state.uid&&m.name!=='나'?' (나)':''}</option>`).join('');$('#item-assignee').value=item?.assignee||'';$('#item-assignee').disabled=!!item;
 $('#item-parent').innerHTML='<option value="">연결하지 않음</option>'+live.agenda.filter(a=>a.room===room&&a.kind==='event'&&a.starts&&a.id!==item?.id).map(a=>`<option value="${a.id}">${esc(a.title)} · ${esc(when(a.starts))}</option>`).join('');$('#item-parent').value=item?.parent||'';$('#item-parent').disabled=!!item;$('#item-offset').value=item?.offset??-30;$('#item-offset').disabled=!!item;$('#item-date').disabled=$('#item-time').disabled=!!item?.parent;$('#item-advanced').open=!!item?.parent;$('#item-advanced').hidden=!!item&&!item.parent;$('#item-assignee-field').hidden=$('#item-kind').value==='event';
 $('#item-save').textContent=item?'변경안 보내기':$('#item-kind').value==='event'?'약속 저장':'할 일 저장';showDialog('#item-editor');
}
async function openHelp(turn){const groups=state.rooms.filter(r=>r.kind==='family');if(!groups.length){toast('먼저 가족방을 만들거나 초대 코드로 참여해 주세요.');showHome(false);return;}live.helpSource=turn;$('#help-room').innerHTML=groups.map(r=>`<option value="${r.id}">${esc(r.title)}</option>`).join('');$('#help-title').value='이 단계에서 도움이 필요해요';const step=turn.answer?.steps?.[turn.completed];$('#help-text').value=step?`“${step.action}”에서 막혔어요.\n${step.detail}`:turn.text;$('#help-image').checked=false;$('#help-image').disabled=!turn.has_image;$('#help-preview-image').hidden=true;$('#help-preview-image').src=turn.has_image?`/api/turns/${turn.id}/image`:'';live.helpRequest=makeId();showDialog('#help-editor');}
function safeAction(fn){return async e=>{const button=e?.submitter||e?.currentTarget;try{if(button?.tagName==='BUTTON')button.disabled=true;await fn(e);}catch(error){toast(error.message);}finally{if(button?.tagName==='BUTTON')button.disabled=false;}};}
function initFeatures(){
 document.body.addEventListener('change',safeAction(async e=>{if(!e.target.matches('[data-reminder]'))return;const select=e.target;select.disabled=true;try{await api(`/api/agenda/${select.dataset.reminder}/reminder`,'PUT',{minutes:select.value?Number(select.value):null});await refreshLive();renderAgendaDetail();toast(select.value?'내 알림을 예약했어요. 시간이 바뀌면 새 시간에 맞춰 알려드려요.':'알림을 껐어요.');}catch(error){await refreshLive();throw error;}finally{select.disabled=false;}}));

 $('#detail-back').onclick=()=>openAgenda(agendaTab);
 $('#item-kind').onchange=()=>{$('#item-assignee-field').hidden=$('#item-kind').value==='event';$('#item-save').textContent=$('#item-kind').value==='event'?'약속 저장':'할 일 저장';};
 $('#create-family').onclick=()=>showDialog('#family-create');$('#join-family').onclick=()=>showDialog('#family-join');
 $('#family-create-form').onsubmit=safeAction(async e=>{e.preventDefault();const r=await api('/api/groups','POST',{title:$('#family-title').value});await refreshLive();await liveOpenRoom(r.id);toast('가족방을 만들었어요. 구성원·초대에서 가족을 초대하세요.');});
 $('#family-join-form').onsubmit=safeAction(async e=>{e.preventDefault();const r=await api('/api/invitations/claim','POST',{code:$('#family-code').value.trim()});$('#family-code').value='';await refreshLive();await liveOpenRoom(r.room);toast('가족방에 참여했어요.');});
 $('#room-members').onclick=safeAction(async()=>{const room=currentRoom(),members=await api(`/api/rooms/${state.room}/members`);$('#members-list').innerHTML=members.map(m=>`<p class="member-row">${esc(m.name)}${m.id===state.uid&&m.name!=='나'?' (나)':''}${m.id===room.uid?' · 방장':''}</p>`).join('');$('#generate-invite').hidden=$('#revoke-invites').hidden=room.uid!==state.uid;$('#leave-family').hidden=room.uid===state.uid;$('#family-invite-output').hidden=true;showDialog('#members-panel');});
 $('#generate-invite').onclick=safeAction(async()=>{const r=await api(`/api/rooms/${state.room}/invite`,'POST',{});$('#family-invite-output').textContent=r.code;$('#family-invite-output').hidden=false;});
 $('#revoke-invites').onclick=safeAction(async()=>{await api(`/api/rooms/${state.room}/invite`,'DELETE',{});$('#family-invite-output').hidden=true;toast('사용 전 초대를 취소했어요.');});
 $('#leave-family').onclick=safeAction(async()=>{await api(`/api/rooms/${state.room}/leave`,'POST',{});$('#members-panel').close();await refreshLive();state.room=state.rooms[0]?.id;showHome(false);});
 $('#room-add-agenda').onclick=safeAction(()=>openItemEditor());
 $('#chat').addEventListener('click',safeAction(async e=>{const save=e.target.closest('[data-save-agenda]'),help=e.target.closest('[data-share-help]');if(save)await openItemEditor(state.turns.find(t=>t.id===save.dataset.saveAgenda));if(help)await openHelp(state.turns.find(t=>t.id===help.dataset.shareHelp));}));
 $('#item-room').onchange=safeAction(async()=>{live.editor.room=$('#item-room').value;const members=await api(`/api/rooms/${live.editor.room}/members`);$('#item-assignee').innerHTML='<option value="">아직 정하지 않음</option>'+members.map(m=>`<option value="${m.id}">${esc(m.name)}</option>`).join('');$('#item-parent').innerHTML='<option value="">연결하지 않음</option>'+live.agenda.filter(a=>a.room===live.editor.room&&a.kind==='event'&&a.starts).map(a=>`<option value="${a.id}">${esc(a.title)}</option>`).join('');$('#item-date').disabled=$('#item-time').disabled=false;});
 $('#item-parent').onchange=()=>{$('#item-date').disabled=$('#item-time').disabled=!!$('#item-parent').value;};
 $('#item-form').onsubmit=safeAction(async e=>{e.preventDefault();const editor=live.editor;if(editor.saving)return;const date=$('#item-date').value,time=$('#item-time').value,parent=$('#item-parent').value;
 if(!parent&&!!date!==!!time){$('#item-form-error').textContent='날짜와 시간을 함께 입력해 주세요. 미정이면 둘 다 비워 두세요.';$('#item-form-error').hidden=false;return;}
 const patch={kind:$('#item-kind').value,title:$('#item-title').value,starts:date&&time?new Date(`${date}T${time}`).toISOString():null,place:$('#item-place').value};
 editor.saving=true;$('#item-save').disabled=true;
 try{let saved;
 if(editor.item){await api(`/api/agenda/${editor.item.id}/changes`,'POST',{version:editor.item.version,patch});saved=editor.item;}else saved=await api('/api/agenda','POST',{...patch,request_id:editor.request_id,room:editor.room,source:editor.source,assignee:patch.kind==='task'?$('#item-assignee').value||null:null,parent:parent||null,offset:Number($('#item-offset').value)});
 await refreshLive();await openAgendaDetail(saved.id);toast(editor.item?'변경안을 보냈어요. 승인되면 반영돼요.':'저장했어요. 메시지에서도 다시 열 수 있어요.');
 }finally{editor.saving=false;$('#item-save').disabled=false;}});

 $('#help-image').onchange=()=>{$('#help-preview-image').hidden=!$('#help-image').checked;};
 $('#help-form').onsubmit=safeAction(async e=>{e.preventDefault();const room=$('#help-room').value;await api('/api/help','POST',{request_id:live.helpRequest,room,source:live.helpSource.id,title:$('#help-title').value,text:$('#help-text').value,share_image:$('#help-image').checked});await refreshLive();await liveOpenRoom(room);toast('선택한 내용으로 가족에게 도움을 요청했어요.');});
 document.body.addEventListener('click',safeAction(async e=>{if(homeDemo)return;
 const detail=e.target.closest('[data-open-agenda]');if(detail){await openAgendaDetail(detail.dataset.openAgenda);return;}
 const room=e.target.closest('[data-live-room]');if(room){await liveOpenRoom(room.dataset.liveRoom);return;}
 const resolve=e.target.closest('[data-help-resolve]');if(resolve){await api(`/api/help/${resolve.dataset.helpResolve}/resolve`,'POST',{});await refreshLive();return;}
 const action=e.target.closest('[data-item-action]');if(action){const a=live.agenda.find(a=>a.id===action.dataset.id);await api(`/api/agenda/${a.id}/${action.dataset.itemAction}`,'POST',{version:a.version,done:!a.done});await refreshLive();renderAgendaDetail();return;}
 const edit=e.target.closest('[data-item-edit]');if(edit){await openItemEditor(null,live.agenda.find(a=>a.id===edit.dataset.itemEdit));return;}
 const change=e.target.closest('[data-change]');if(change){await api(`/api/changes/${change.dataset.change}/${change.dataset.decision}`,'POST',{});await refreshLive();renderAgendaDetail();return;}
 const history=e.target.closest('[data-item-history]');if(history){const rows=await api(`/api/agenda/${history.dataset.itemHistory}/history`);$('#history-list').innerHTML=rows.length?rows.map(h=>`<article class="agenda-item"><small>${esc(when(new Date(h.created*1000).toISOString()))}</small><p>이전: ${esc(h.before.title)} · ${esc(when(h.before.starts))} · ${esc(h.before.place)}</p><p>변경: ${esc(h.after.title)} · ${esc(when(h.after.starts))} · ${esc(h.after.place)}</p></article>`).join(''):'<p class="agenda-empty">아직 변경 기록이 없어요.</p>';showDialog('#history-panel');}
 }));
 $('#open-notices').onclick=safeAction(async()=>{await refreshLive();$('#notices-list').innerHTML=live.notices.length?live.notices.map(n=>`<button class="notice-row ${n.seen?'':'unread'}" data-live-room="${n.room}"><b>${esc(n.text)}</b><small>${esc(when(new Date(n.created*1000).toISOString()))}</small></button>`).join(''):'<p class="agenda-empty">아직 새 소식이 없어요.</p>';showDialog('#notices-panel');await api('/api/notices/seen','POST',{ids:live.notices.filter(n=>!n.seen).map(n=>n.id)});live.notices.forEach(n=>n.seen=1);liveRenderAgenda();});
 $('#save-name').onclick=safeAction(async()=>{state.profile=await api('/api/profile','PUT',{...state.profile,name:$('#profile-name').value.trim()});profileUI();await refreshLive();toast('이름을 저장했어요.');});
 const savePrefs=safeAction(async()=>{live.preferences=await api('/api/preferences','PUT',{font:$('#pref-font').value,speech:Number($('#pref-speech').value)});applyPreferences();toast('내 화면에 적용했어요.');});$('#pref-font').onchange=$('#pref-speech').onchange=savePrefs;
 initVoice();
}
function initVoice(){
 const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
 $('#voice-input').onclick=()=>{showDialog('#voice-panel');$('#voice-transcript').value='';$('#voice-status').textContent=Recognition?'시작을 누르면 마이크를 사용해요.':'이 브라우저는 음성 입력을 지원하지 않아요. 휴대폰 키보드의 마이크나 사진 입력을 이용해 주세요.';$('#voice-start').disabled=!Recognition;};
 $('#voice-start').onclick=()=>{if(!Recognition)return;live.recognition?.abort();const r=new Recognition();live.recognition=r;r.lang='ko-KR';r.interimResults=true;r.continuous=true;$('#voice-start').disabled=true;$('#voice-stop').disabled=false;$('#voice-status').textContent='듣고 있어요. 끝나면 그만 듣기를 눌러 주세요.';
 r.onresult=e=>{$('#voice-transcript').value=Array.from(e.results,result=>result[0].transcript).join(' ');};r.onerror=e=>{$('#voice-status').textContent=e.error==='not-allowed'?'마이크 권한을 허용한 뒤 다시 시도해 주세요.':'음성을 인식하지 못했어요. 다시 말하거나 직접 입력해 주세요.';};r.onend=()=>{$('#voice-start').disabled=false;$('#voice-stop').disabled=true;};try{r.start();}catch{$('#voice-status').textContent='마이크를 시작하지 못했어요.';$('#voice-start').disabled=false;$('#voice-stop').disabled=true;}
 };
 $('#voice-stop').onclick=()=>{live.recognition?.stop();$('#voice-status').textContent='인식된 문장을 확인하고 고쳐 주세요.';};
 $('#voice-use').onclick=()=>{const text=$('#voice-transcript').value.trim();if(!text)return;live.recognition?.abort();prefill([$('#message').value,text].filter(Boolean).join(' '));$('#voice-panel').close();toast('입력창에 넣었어요. 확인한 뒤 전송해 주세요.');};
 $('#voice-panel').addEventListener('close',()=>live.recognition?.abort());
}
