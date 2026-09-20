'use strict';
const $ = s => document.querySelector(s);
const modes = {easy:'쉽게 듣기',guided:'한 단계씩',expert:'자세히 보기'};
const state = {account:{},profile:{name:'나',mode:'easy'}, rooms:[], room:null, turns:[], image:null, sending:false, polling:null, loading:0, ready:false, outbox:null};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = s => esc(s).replace(/(\d{1,2}시간 \d{1,2}분|\d{1,2}시 \d{1,2}분|\d{1,2}:\d{2}|\d{1,2}시간|\d{1,2}시|\d{1,3}분)/g,'<b>$1</b>');
const symbol = '<svg class="icon" aria-hidden="true"><use href="#i-spark"/></svg>';
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const stamp = t => new Date(t*1000).toLocaleTimeString('ko-KR',{hour:'numeric',minute:'2-digit'});
const makeId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), v=>v.toString(16).padStart(2,'0')).join('');
let toastTimer;
function toast(text) { $('#toast').textContent=text; $('#toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#toast').hidden=true,5500); }
function remember(key, value) { try { value===null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key,JSON.stringify(value)); } catch {} }
function recall(key) { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } }
async function api(path, method='GET', body) {
  let response;
  try { response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(18000)}); }
  catch { const e=new Error('서버에 연결되지 않아요. 연결 후 다시 시도해 주세요.'); e.network=true; throw e; }
  const data=await response.json().catch(()=>({}));
  if(!response.ok) { const e=new Error(typeof data.detail==='string'?data.detail:'입력 내용을 확인해 주세요.'); e.status=response.status; throw e; }
  return data;
}
function showDialog(id) { document.querySelectorAll('dialog[open]').forEach(d=>d.close()); $(id).showModal(); }
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
document.querySelectorAll('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientY<r.top||e.clientX<r.left||e.clientX>r.right)d.close();}}));
function network(message='') { $('#connection').hidden=!message; $('#connection').textContent=message; }
function buttons() {
  const pending=state.turns.some(t=>t.status==='pending');
  $('#send').disabled=!state.ready||state.sending||pending||(!$('#message').value.trim()&&!state.image);
  $('#attach').disabled=!state.ready||state.sending;
}
function composerResize() { const t=$('#message');t.style.height='auto';t.style.height=Math.min(t.scrollHeight,110)+'px';buttons(); }
$('#message').addEventListener('input',composerResize);
$('#message').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();$('#composer').requestSubmit();}});
function prefill(text) { $('#message').value=text;composerResize();$('#message').focus(); }
function profileUI() { $('#mode-pill').textContent=modes[state.profile.mode];document.querySelectorAll('#modes input').forEach(r=>r.checked=r.value===state.profile.mode); }
function renderRooms() {
  $('#rooms-list').innerHTML=state.rooms.map(r=>`<button class="room-item ${r.id===state.room?'active':''}" data-room="${r.id}">${esc(r.title)}<small>${new Date(r.created*1000).toLocaleDateString('ko-KR')}</small></button>`).join('');
  $('#room-title').textContent=state.rooms.find(r=>r.id===state.room)?.title||'나의 대화';
}
function details(a, mode) {
  if(!a.facts.length)return '';
  if(mode==='easy')return a.facts.map(f=>`<p class="easy-fact"><span>${esc(f.label)}</span>${fmt(f.value)}</p>`).join('');
  return `<table class="kv">${a.facts.map(f=>`<tr><th>${esc(f.label)}</th><td>${fmt(f.value)}</td></tr>`).join('')}</table>`;
}
function steps(t) {
  const a=t.answer;
  if(!a.steps.length)return '';
  const total=a.steps.length, n=Math.min(t.completed,total), s=a.steps[n];
  return `<div class="task-card">
    <div class="card-head"><span class="card-title">지금 할 일</span><span class="card-count">${s?`${n+1} / ${total}단계`:'모두 마쳤어요'}</span></div>
    <div class="progress"><i style="width:${Math.round((s?n+1:total)/total*100)}%"></i></div>
    ${n?`<div class="step-history">${a.steps.slice(0,n).map(x=>`✓ ${esc(x.action)}`).join('<br>')}</div>`:''}
    ${s?`${a.goal?`<div class="card-goal">${esc(a.goal)}</div>`:''}<div class="step-action">${fmt(s.action)}</div><div class="step-detail">${fmt(s.detail)}</div><div class="confirm-q">${esc(s.question)}</div><div class="chip-row"><button class="chip primary" data-step="${t.id}">네, 했어요</button><button class="chip ghost" data-help="${t.id}">잘 안돼요</button></div>`:'<div class="done-msg">차근차근 잘 마치셨어요.</div>'}
  </div>`;
}
function answer(t) {
  if(t.status==='pending')return '<div class="pending" role="status"><span class="pending-dots"><i></i><i></i><i></i></span>차근차근 살펴보고 있어요</div>';
  if(t.status==='failed')return `<div class="error-box">${esc(t.error)}<br><button class="chip ghost" data-retry="${t.id}">다시 시도하기</button></div>`;
  const a=t.answer;
  return `<div class="bubble">${fmt(a.summary)}</div>
    <button class="answer-speech" data-voice="${t.id}">${icon('speaker')} 소리로 듣기</button>
    ${a.caution?`<div class="alert-badge">${icon('clock')}<span>${fmt(a.caution)}</span></div>`:''}
    ${a.facts.length?`<div class="task-card">${details(a,t.mode)}</div>`:''}
    ${steps(t)}
    ${a.question?`<div class="follow-up"><b>조금만 더 알려주세요</b>${fmt(a.question)}</div>`:''}
    ${a.suggestions.length?`<div class="suggest-list"><div class="suggest-cap">이어서 물어보세요</div>${a.suggestions.map((s,i)=>`<button class="suggest-action" data-suggestion="${t.id}" data-index="${i}"><span>${esc(s)}</span><span class="chev">›</span></button>`).join('')}</div>`:''}`;
}
function render(forceBottom=false) {
  const chat=$('#chat'), bottom=chat.scrollHeight-chat.scrollTop-chat.clientHeight<90, scroll=chat.scrollTop;
  if(!state.turns.length) {
    chat.innerHTML=`<div class="welcome"><div class="welcome-symbol">${symbol.replace('class="icon"','class="welcome-symbol"')}</div><h2>어려운 일상에,<br>곁에가 함께할게요.</h2><p>궁금한 걸 편하게 적어주세요.<br>받은 문자나 사진도 함께 살펴볼게요.</p><div class="starters"><button data-starter="받은 문자가 무슨 뜻인지 알고 싶어요.">받은 문자, 같이 읽어주세요 <span>›</span></button><button data-starter="휴대폰 글씨를 크게 바꾸고 싶어요.">휴대폰 쓰는 게 어려워요 <span>›</span></button></div></div>`;
  } else {
    chat.innerHTML=state.turns.map(t=>`<section class="turn" data-turn="${t.id}"><div class="msg me"><div class="msg-body"><div class="msg-meta"><b>${esc(state.profile.name)}</b>${stamp(t.created)}</div><div class="bubble">${t.has_image?`<img class="user-photo" src="/api/turns/${t.id}/image" alt="내가 보낸 사진" loading="lazy">`:''}${t.text?`<div class="user-text">${esc(t.text)}</div>`:''}</div></div></div><div class="msg ai-answer" data-mode="${t.mode}"><div class="avatar ai">${symbol}</div><div class="msg-body wide"><div class="msg-meta"><b>곁에</b>${modes[t.mode]}</div>${answer(t)}</div></div></section>`).join('');
  }
  buttons();
  if(forceBottom||bottom)chat.scrollTop=chat.scrollHeight; else chat.scrollTop=scroll;
}
function poll() {
  clearTimeout(state.polling);
  state.polling=setTimeout(async()=>{
    if(document.hidden){poll();return;}
    const room=state.room;
    try {
      const turns=await api(`/api/rooms/${room}/turns`);
      if(room!==state.room)return;
      if(JSON.stringify(turns)!==JSON.stringify(state.turns)){state.turns=turns;render();}
      network();
    }catch(e){network(e.message);}
    poll();
  },state.turns.some(t=>t.status==='pending')?1400:7000);
}
async function chooseRoom(id) {
  const version=++state.loading;
  const turns=await api(`/api/rooms/${id}/turns`);
  if(version!==state.loading)return;
  state.room=id;state.turns=turns;remember('room',id);renderRooms();render(true);poll();
}
async function boot() {
  try {
    const session=await api('/api/session','POST');state.account=session.account||{};state.profile=session.profile;profileUI();if(session.access_code){$('#access-hint').textContent='휴대폰에서 처음 열 때 입력할 접속 코드: '+session.access_code;$('#access-hint').hidden=false;}
    state.rooms=await api('/api/rooms');
    const room=state.rooms.find(r=>r.id===recall('room'))||state.rooms[0];
    await chooseRoom(room.id);state.ready=true;buttons();$('#entry').hidden=true;$('#app-frame').hidden=false;
    if(!session.ai_ready)network('AI 연결 설정이 아직 준비되지 않았어요.');
    const outbox=recall('outbox');
    if(outbox){
      try {await api(`/api/turns/${outbox.body.request_id}`);remember('outbox',null);}
      catch(e){if(e.status===404){state.outbox=outbox;await chooseRoom(outbox.room);$('#message').value=outbox.body.text; if(outbox.body.image){state.image={data:outbox.body.image,type:outbox.body.image_type};showAttachment();}composerResize();toast('보내던 내용이 남아 있어요. 전송 버튼으로 다시 보내세요.');}}
    }
  }catch(e){
    if(e.status===401){
      state.ready=false;buttons();$('#app-frame').hidden=true;$('#entry').hidden=false;
      const auth=await api('/api/auth/status').catch(()=>({google_enabled:false}));
      $('#entry-login').hidden=!auth.google_enabled;
      return;
    }
    $('#entry-status').hidden=false;$('#entry-status').textContent='연결이 잠시 어려워요. 인터넷 연결을 확인하고 다시 시작해 주세요.';}
}
$('#entry-start').onclick=()=>{$('#entry-welcome').hidden=true;$('#entry-connect').hidden=false;$('#entry-back').focus();};
$('#entry-back').onclick=()=>{$('#entry-connect').hidden=true;$('#entry-welcome').hidden=false;$('#entry-start').focus();};
$('#entry-login').onclick=()=>startGoogle($('#entry-login'));
$('#unlock-form').onsubmit=async e=>{
  e.preventDefault();const button=$('#entry-submit');button.disabled=true;button.textContent='연결하고 있어요…';$('#entry-error').hidden=true;$('#entry-status').hidden=true;
  try{await api('/api/session','POST',{access_code:$('#access-input').value.trim()});$('#access-input').value='';await boot();}
  catch(error){$('#entry-error').textContent=error.message;$('#entry-error').hidden=false;}
  finally{button.disabled=false;button.innerHTML='시작하기 <span aria-hidden="true">→</span>';}
};
$('#composer').addEventListener('submit',async e=>{
  e.preventDefault();if($('#send').disabled)return;
  const text=$('#message').value.trim(), image=state.image;
  const same=state.outbox&&state.outbox.room===state.room&&state.outbox.body.text===text&&state.outbox.body.image===(image?.data||null);
  const body=same?state.outbox.body:{request_id:makeId(),text,image:image?.data||null,image_type:image?.type||null};
  state.outbox={room:state.room,body};remember('outbox',state.outbox);state.sending=true;buttons();
  try {
    const turn=await api(`/api/rooms/${state.room}/turns`,'POST',body);
    state.turns=state.turns.filter(t=>t.id!==turn.id);state.turns.push(turn);
    $('#message').value='';state.image=null;showAttachment();state.outbox=null;remember('outbox',null);composerResize();render(true);
    state.rooms=await api('/api/rooms');renderRooms();network();poll();
  }catch(err){toast(err.message); if(!err.network){state.outbox=null;remember('outbox',null);}}
  finally{state.sending=false;buttons();}
});
$('#chat').addEventListener('click',async e=>{
  const btn=e.target.closest('button');if(!btn)return;
  if(btn.dataset.starter){prefill(btn.dataset.starter);return;}
  const id=btn.dataset.step||btn.dataset.help||btn.dataset.voice||btn.dataset.retry||btn.dataset.suggestion;
  const t=state.turns.find(t=>t.id===id);if(!t)return;
  if(btn.dataset.suggestion){prefill(t.answer.suggestions[Number(btn.dataset.index)]);return;}
  if(btn.dataset.help){prefill(`“${t.answer.steps[t.completed].action}”에서 막혔어요. 더 쉽게 설명해 주세요.`);return;}
  if(btn.dataset.voice){
    if(!('speechSynthesis' in window)){toast('이 브라우저에서는 소리로 듣기를 지원하지 않아요.');return;}
    if(speechSynthesis.speaking){speechSynthesis.cancel();btn.innerHTML=icon('speaker')+' 소리로 듣기';return;}
    const u=new SpeechSynthesisUtterance(t.answer.voice||t.answer.summary);u.lang='ko-KR';u.rate=.9;
    btn.innerHTML=icon('speaker')+' 멈추기';const reset=()=>btn.innerHTML=icon('speaker')+' 소리로 듣기';u.onend=reset;u.onerror=()=>{reset();toast('이 기기에서 한국어 음성을 재생하지 못했어요.');};speechSynthesis.speak(u);return;
  }
  btn.disabled=true;
  try {
    if(btn.dataset.retry){const newTurn=await api(`/api/turns/${id}/retry`,'POST');Object.assign(t,newTurn);poll();}
    if(btn.dataset.step){const r=await api(`/api/turns/${id}/progress`,'PUT',{completed:t.completed+1});t.completed=r.completed;}
    render();
  }catch(err){toast(err.message);btn.disabled=false;}
});
$('#open-settings').onclick=$('#mode-pill').onclick=()=>{profileUI();showDialog('#settings');};
$('#modes').addEventListener('change',async e=>{
  if(!e.target.matches('input'))return;
  try{state.profile=await api('/api/profile','PUT',{...state.profile,mode:e.target.value});profileUI();$('#settings').close();toast('다음 답변부터 이 방식으로 알려드릴게요.');}
  catch(err){profileUI();toast(err.message);}
});
$('#open-rooms').onclick=async()=>{try{state.rooms=await api('/api/rooms');renderRooms();showDialog('#rooms-panel');}catch(e){toast(e.message);}};
$('#rooms-list').onclick=async e=>{const b=e.target.closest('[data-room]');if(!b)return;try{await chooseRoom(b.dataset.room);$('#rooms-panel').close();}catch(e){toast(e.message);}};
$('#new-room').onclick=async()=>{try{const r=await api('/api/rooms','POST');state.rooms=await api('/api/rooms');await chooseRoom(r.id);$('#rooms-panel').close();}catch(e){toast(e.message);}};
function showAttachment(){const p=$('#attachment-preview');p.hidden=!state.image;if(state.image)p.querySelector('img').src=`data:${state.image.type};base64,${state.image.data}`;else p.querySelector('img').removeAttribute('src');buttons();}
$('#attach').onclick=()=>$('#photo').click();$('#remove-attachment').onclick=()=>{state.image=null;showAttachment();};
$('#photo').onchange=async e=>{
  const file=e.target.files[0];e.target.value='';if(!file)return;
  if(file.size>20*1024*1024){toast('20MB 이하의 사진을 선택해 주세요.');return;}
  const url=URL.createObjectURL(file);
  try {
    const img=new Image();img.src=url;await img.decode();
    const scale=Math.min(1,1600/Math.max(img.naturalWidth,img.naturalHeight));
    const c=document.createElement('canvas');c.width=Math.max(1,Math.round(img.naturalWidth*scale));c.height=Math.max(1,Math.round(img.naturalHeight*scale));
    const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);ctx.drawImage(img,0,0,c.width,c.height);
    const data=c.toDataURL('image/jpeg',.8).split(',')[1];
    if(data.length>2800000)throw new Error('사진을 조금 작게 해서 다시 골라 주세요.');
    state.image={type:'image/jpeg',data};showAttachment();
  }catch(err){toast(err.message?.includes('사진')?err.message:'사진을 읽지 못했어요. JPG·PNG 사진이나 화면 캡처로 다시 시도해 주세요.');}
  finally{URL.revokeObjectURL(url);}
};
async function startGoogle(button){
  button.disabled=true;
  try{const r=await api('/api/auth/google/start','POST',{});location.assign(r.url);}
  catch(e){toast(e.message);button.disabled=false;}
}
$('#open-account').onclick=async()=>{
  try{
    const a=await api('/api/auth/status');state.account=a;
    $('#account-description').textContent=a.linked?'대화를 Google 계정에 안전하게 연결했어요.':'소중한 대화를 다시 찾을 수 있게 준비해요.';
    $('#account-email').textContent=a.email||'';$('#account-email').hidden=!a.linked;
    $('#link-google').hidden=a.linked;$('#link-google').disabled=!a.google_enabled;
    $('#account-note').textContent=a.linked?'다른 기기에서도 같은 Google 계정으로 로그인하면 지금 대화를 이어볼 수 있어요.':a.google_enabled?'지금의 대화를 Google 계정에 연결해요. 휴대폰을 바꾸거나 앱을 다시 설치해도 같은 계정으로 이어볼 수 있어요.':'Google 로그인 연결을 준비 중이에요. 지금은 설정의 다른 기기에서 이어보기를 이용해 주세요.';
    $('#logout').hidden=!state.ready;$('#logout-all').hidden=!a.linked;showDialog('#account-panel');
  }catch(e){toast(e.message);}
};
$('#link-google').onclick=()=>startGoogle($('#link-google'));
let logoutAll=false;
function confirmLogout(all){
  logoutAll=all;
  $('#logout-message').textContent=!state.account.linked?'아직 Google 계정을 연결하지 않았어요. 다른 연결 기기가 없다면 로그아웃 후 지금 대화를 다시 찾을 수 없어요. 먼저 계정을 연결하는 것을 권해요.':all?'모든 기기의 연결을 해제해요. 다시 이용하려면 Google 계정으로 로그인해 주세요.':'대화는 계정에 남아 있어요. 같은 Google 계정으로 다시 로그인하면 이어볼 수 있어요.';
  showDialog('#logout-confirm');
}
$('#logout').onclick=()=>confirmLogout(false);$('#logout-all').onclick=()=>confirmLogout(true);
$('#confirm-logout').onclick=async()=>{
  const button=$('#confirm-logout');button.disabled=true;
  try{await api('/api/auth/logout','POST',{all:logoutAll});clearTimeout(state.polling);sessionStorage.clear();if('speechSynthesis' in window)speechSynthesis.cancel();location.replace('/');}
  catch(e){toast(e.message);button.disabled=false;}
};
$('#devices').onclick=()=>showDialog('#device-panel');
$('#make-code').onclick=async()=>{try{const r=await api('/api/pairing','POST');$('#pair-code').textContent=r.code;$('#pair-code').hidden=false;}catch(e){toast(e.message);}};
$('#claim-form').onsubmit=async e=>{e.preventDefault();const b=e.target.querySelector('button');b.disabled=true;try{await api('/api/pairing/claim','POST',{code:$('#pair-input').value});clearTimeout(state.polling);state.turns=[];state.image=null;state.outbox=null;remember('room',null);remember('outbox',null);$('#message').value='';$('#pair-input').value='';$('#pair-code').hidden=true;showAttachment();$('#device-panel').close();await boot();toast('대화를 연결했어요.');}catch(e){toast(e.message);}finally{b.disabled=false;}};
let installPrompt=null;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;});
$('#install').onclick=()=>{
  showDialog('#install-panel');$('#install-now').hidden=!installPrompt;
  $('#install-note').textContent=matchMedia('(display-mode: standalone)').matches?'이미 앱으로 열려 있어요.':!window.isSecureContext?'현재 주소는 같은 Wi-Fi에서 확인하는 테스트 주소예요. 정식 앱 설치에는 HTTPS 주소가 필요해요.':'홈 화면에 추가하면 아이콘을 눌러 앱처럼 열 수 있어요.';
};
$('#install-now').onclick=async()=>{if(installPrompt){await installPrompt.prompt();installPrompt=null;$('#install-now').hidden=true;}};
window.addEventListener('offline',()=>network('인터넷 연결이 끊겼어요. 작성 중인 내용은 이 화면에 남아 있어요.'));
window.addEventListener('online',()=>{network();if(state.ready)poll();else boot();});
window.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.ready)poll();});
if('serviceWorker' in navigator&&window.isSecureContext)navigator.serviceWorker.register('/sw.js').catch(()=>{});
const authMessages={success:'Google 계정으로 연결했어요. 대화를 이어가세요.',expired:'로그인 시간이 지났어요. 다시 시작해 주세요.',cancelled:'Google 로그인을 취소했어요.',failed:'Google 로그인에 실패했어요. 다시 시도해 주세요.',unavailable:'Google 로그인을 준비하고 있어요.',invite:'처음 이용하실 때는 접속 코드로 시작한 뒤 설정에서 Google 계정을 연결해 주세요.',conflict:'이미 다른 대화에 연결된 계정이에요. 기존 대화를 열려면 로그아웃한 뒤 Google로 로그인해 주세요.'};
if(location.hash.startsWith('#auth=')){
  const result=location.hash.slice(6);history.replaceState(null,'',location.pathname+location.search);
  if(result==='success'){remember('room',null);remember('outbox',null);}
  if(authMessages[result])toast(authMessages[result]);
}
buttons();
boot();
