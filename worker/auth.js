import {createRemoteJWKSet, jwtVerify} from 'jose';

const keys=createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),v=>v.toString(16).padStart(2,'0')).join('');
const random=()=>crypto.randomUUID()+crypto.randomUUID();
const time=()=>Date.now()/1000;
const json=(data,status=200,headers={})=>Response.json(data,{status,headers:{'Cache-Control':'no-store',...headers}});
const cookie=(request,name)=>(request.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1)||'';
const oauthCookie=(value,request,age=600)=>`gyeote_oauth=${value}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=${age}${new URL(request.url).protocol==='https:'?'; Secure':''}`;
const enabled=env=>!!(env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET);
const callback=request=>new URL('/api/auth/google/callback',request.url).href;

export function initAuth(store){
  store.run(`CREATE TABLE IF NOT EXISTS identities(subject TEXT PRIMARY KEY,uid TEXT NOT NULL UNIQUE,email TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_flows(state TEXT PRIMARY KEY,binding TEXT NOT NULL,uid TEXT,session TEXT,nonce TEXT NOT NULL,verifier TEXT NOT NULL,expires REAL NOT NULL,signup INTEGER NOT NULL);`);
}
export function account(store,uid){
  const identity=uid?store.one('SELECT email FROM identities WHERE uid=?',uid):null;
  return {google_enabled:enabled(store.env),linked:!!identity,email:identity?.email||null};
}
async function exchange(code,flow,request,env){
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,redirect_uri:callback(request),grant_type:'authorization_code',code_verifier:flow.verifier}),signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw new Error('token');
  const data=await r.json();
  return verifyGoogleToken(data.id_token,flow.nonce,env.GOOGLE_CLIENT_ID);
}
export async function verifyGoogleToken(token,nonce,clientId,jwks=keys){
  const {payload}=await jwtVerify(token,jwks,{issuer:['https://accounts.google.com','accounts.google.com'],audience:clientId,algorithms:['RS256'],requiredClaims:['sub','exp','iat','nonce'],maxTokenAge:'10 minutes',clockTolerance:10});
  if(payload.nonce!==nonce||!payload.sub||payload.email_verified!==true||typeof payload.email!=='string'||(payload.azp&&payload.azp!==clientId))throw new Error('claims');
  return {subject:payload.sub,email:payload.email};
}
// Token verification is replaceable only by unit tests, never by an environment flag.
export async function authRoute(store,request,{uid,token,b,ip},verify=exchange){
  const url=new URL(request.url),path=url.pathname,method=request.method;
  if(path==='/api/auth/status'&&method==='GET')return json(account(store,uid));
  if(path==='/api/auth/logout'&&method==='POST'){
    if(!uid)return json({detail:'로그인이 필요해요.'},401);
    if(b.all&&!store.one('SELECT uid FROM identities WHERE uid=?',uid))return json({detail:'먼저 Google 계정을 연결해 주세요.'},409);
    store.run(b.all?'DELETE FROM sessions WHERE uid=?':'DELETE FROM sessions WHERE token=?',b.all?uid:token);
    store.run('DELETE FROM oauth_flows WHERE uid=?',uid);
    if(b.all)store.run('DELETE FROM pairing WHERE uid=?',uid);
    return json({ok:true},200,{'Set-Cookie':`gyeote_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${url.protocol==='https:'?'; Secure':''}`});
  }
  if(path==='/api/auth/google/start'&&method==='POST'){
    if(!enabled(store.env))return json({detail:'Google 로그인을 준비하고 있어요. 기존 접속 코드를 이용해 주세요.'},503);
    store.limit('google-start:'+ip,15,600);
    // New Google accounts still require the pilot invitation; returning users do not.
    let signup=0;
    if(!uid&&b.access_code){
      store.limit('access:'+ip,8,600);
      if(!store.env.ACCESS_CODE||await hash(String(b.access_code))!==await hash(store.env.ACCESS_CODE))return json({detail:'접속 코드를 확인해 주세요.'},401);
      signup=1;
    }
    const state=random(),binding=random(),nonce=random(),verifier=random();
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier));
    const challenge=btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    store.run('DELETE FROM oauth_flows WHERE expires<?',time());
    store.run('INSERT INTO oauth_flows VALUES(?,?,?,?,?,?,?,?)',await hash(state),await hash(binding),uid||null,uid?token:null,nonce,verifier,time()+600,signup);
    const auth=new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.search=new URLSearchParams({client_id:store.env.GOOGLE_CLIENT_ID,redirect_uri:callback(request),response_type:'code',scope:'openid email',state,nonce,code_challenge:challenge,code_challenge_method:'S256',prompt:'select_account'});
    return json({url:auth.href},200,{'Set-Cookie':oauthCookie(binding,request)});
  }
  if(path==='/api/auth/google/callback'&&method==='GET'){
    const redirect=(result,session)=>{const headers=new Headers({'Location':'/#auth='+result,'Cache-Control':'no-store'});headers.append('Set-Cookie',oauthCookie('',request,0));if(session)headers.append('Set-Cookie',session);return new Response(null,{status:303,headers});};
    if(!enabled(store.env))return redirect('unavailable');
    const state=url.searchParams.get('state')||'',binding=cookie(request,'gyeote_oauth');
    if(!state||state.length>200||!binding)return redirect('expired');
    const stateHash=await hash(state),bindingHash=await hash(binding);
    // Consume synchronously before token exchange, so concurrent callbacks cannot replay it.
    const flow=store.one('SELECT * FROM oauth_flows WHERE state=? AND binding=? AND expires>?',stateHash,bindingHash,time());
    if(!flow)return redirect('expired');
    store.run('DELETE FROM oauth_flows WHERE state=?',stateHash);
    if(url.searchParams.has('error'))return redirect('cancelled');
    const code=url.searchParams.get('code');if(!code||code.length>4096)return redirect('failed');
    let identity;try{identity=await verify(code,flow,request,store.env);}catch{return redirect('failed');}
    const newToken=random(),newTokenHash=await hash(newToken);
    let target,result='success';
    store.ctx.storage.transactionSync(()=>{
      const existing=store.one('SELECT * FROM identities WHERE subject=?',identity.subject);
      if(flow.uid){
        // A revoked linking session must never gain access again via an old callback.
        if(!store.one('SELECT uid FROM sessions WHERE token=? AND uid=? AND expires>?',flow.session,flow.uid,time())){result='expired';return;}
        const linked=store.one('SELECT * FROM identities WHERE uid=?',flow.uid);
        if((existing&&existing.uid!==flow.uid)||(linked&&linked.subject!==identity.subject)){result='conflict';return;}
        target=flow.uid;
      }else if(existing)target=existing.uid;
      else{
        if(!flow.signup){result='invite';return;}
        target=crypto.randomUUID();store.run("INSERT INTO users VALUES(?,'나','easy')",target);
        store.run('INSERT INTO rooms VALUES(?,?,?,?)',crypto.randomUUID(),target,'첫 대화',time());
      }
      if(!existing)store.run('INSERT INTO identities VALUES(?,?,?)',identity.subject,target,identity.email);
      else store.run('UPDATE identities SET email=? WHERE subject=?',identity.email,identity.subject);
      if(flow.session)store.run('DELETE FROM sessions WHERE token=?',flow.session);
      store.run('INSERT INTO sessions VALUES(?,?,?)',newTokenHash,target,time()+90*86400);
    });
    if(result!=='success')return redirect(result);
    return redirect('success',`gyeote_session=${newToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=7776000${url.protocol==='https:'?'; Secure':''}`);
  }
  return null;
}
