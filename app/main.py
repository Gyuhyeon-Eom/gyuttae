import asyncio
import base64
import hashlib
import json
import os
import secrets
import sqlite3
import time
import uuid
from collections import defaultdict, deque
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from .provider import ClaudeProvider, ProviderError

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / 'static'
COOKIE = 'gyeote_session'
Mode = Literal['easy', 'guided', 'expert']

def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()

class Input(BaseModel):
    model_config = ConfigDict(extra='forbid')

class Access(Input):
    access_code: str = Field(default='', max_length=128)

class Profile(Input):
    name: str = Field(min_length=1, max_length=20)
    mode: Mode

class Send(Input):
    request_id: str = Field(pattern=r'^[a-zA-Z0-9-]{16,80}$')
    text: str = Field(default='', max_length=6000)
    image: str | None = Field(default=None, max_length=3000000)
    image_type: Literal['image/jpeg', 'image/png', 'image/webp'] | None = None

class Pair(Input):
    code: str = Field(pattern=r'^\d{8}$')

class Progress(Input):
    completed: int = Field(ge=0, le=8)

class DB:
    def __init__(self, path):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as c:
            c.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, uid TEXT NOT NULL REFERENCES users(id), expires REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, uid TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY, uid TEXT NOT NULL REFERENCES users(id), room TEXT NOT NULL REFERENCES rooms(id), fingerprint TEXT NOT NULL,
                text TEXT NOT NULL, image BLOB, image_type TEXT, mode TEXT NOT NULL, status TEXT NOT NULL,
                answer TEXT, error TEXT, usage TEXT, completed INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS attempts(uid TEXT NOT NULL, created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS pairing(code TEXT PRIMARY KEY, uid TEXT NOT NULL, expires REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS room_turns ON turns(room, created);
            CREATE INDEX IF NOT EXISTS daily_attempts ON attempts(created);
            ''')
            c.execute("UPDATE turns SET status='failed', error='서버가 다시 시작됐어요. 다시 시도해 주세요.' WHERE status='pending'")

    @contextmanager
    def connect(self):
        c = sqlite3.connect(self.path, timeout=10)
        c.row_factory = sqlite3.Row
        c.execute('PRAGMA foreign_keys=ON')
        try:
            c.execute('BEGIN IMMEDIATE')
            yield c
            c.commit()
        except Exception:
            c.rollback()
            raise
        finally:
            c.close()

class LimitBody:
    def __init__(self, app): self.app = app
    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        if scope['method'] in ('POST', 'PUT', 'PATCH'):
            chunks, size = [], 0
            while True:
                message = await receive()
                if message['type'] == 'http.disconnect': return
                size += len(message.get('body', b''))
                if size > 3200000:
                    return await JSONResponse({'detail': '사진이나 문장이 너무 커요.'}, status_code=413)(scope, receive, send)
                chunks.append(message.get('body', b''))
                if not message.get('more_body'): break
            delivered = False
            async def buffered():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {'type': 'http.request', 'body': b''.join(chunks), 'more_body': False}
                return await receive()
            return await self.app(scope, buffered, send)
        return await self.app(scope, receive, send)


def create_app(db_path=None, provider=None):
    db = DB(db_path or os.getenv('GYEOTE_CHAT_DB', str(ROOT / 'data/chat.sqlite')))
    ai = provider or ClaudeProvider()
    access_path = Path(db.path).parent / 'access-code.txt'
    access_code = os.getenv('GYEOTE_ACCESS_CODE')
    if not access_code:
        if not access_path.exists():
            fd = os.open(access_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as f:
                f.write(''.join(secrets.choice('0123456789') for _ in range(12)))
        access_code = access_path.read_text().strip()
    jobs = set()
    rate = defaultdict(deque)

    @asynccontextmanager
    async def lifespan(app):
        yield
        for task in list(jobs): task.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)

    app = FastAPI(title='곁에', lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(LimitBody)
    app.state.db, app.state.jobs = db, jobs

    @app.middleware('http')
    async def privacy(request, call_next):
        if request.url.path.startswith('/api/') and request.method != 'GET':
            origin = request.headers.get('origin')
            if origin and origin.rstrip('/') != str(request.base_url).rstrip('/'):
                return JSONResponse({'detail': '현재 앱 화면에서 다시 시도해 주세요.'}, status_code=403)
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
        if request.url.path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'
        elif request.url.path in ('/', '/sw.js', '/app.js', '/manifest.webmanifest'):
            response.headers['Cache-Control'] = 'no-cache'
        return response

    def throttle(key, cap, window):
        q = rate[key]
        now = time.time()
        while q and q[0] < now - window: q.popleft()
        if len(q) >= cap: raise HTTPException(429, '요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.')
        q.append(now)

    def who(request):
        with db.connect() as c:
            r = c.execute('SELECT uid FROM sessions WHERE token=? AND expires>?', (digest(request.cookies.get(COOKIE, '')), time.time())).fetchone()
        if not r: raise HTTPException(401, '기기 연결이 만료됐어요. 새로고침해 주세요.')
        return r['uid']

    def set_session(c, uid, response, request):
        token = secrets.token_urlsafe(32)
        c.execute('INSERT INTO sessions VALUES(?,?,?)', (digest(token), uid, time.time()+86400*90))
        response.set_cookie(COOKIE, token, httponly=True, samesite='strict', secure=request.url.scheme=='https', max_age=86400*90)

    def own_room(c, room, uid):
        if not c.execute('SELECT 1 FROM rooms WHERE id=? AND uid=?', (room, uid)).fetchone():
            raise HTTPException(404, '대화를 찾지 못했어요.')

    def own_turn(c, tid, uid):
        row = c.execute('SELECT * FROM turns WHERE id=? AND uid=?', (tid, uid)).fetchone()
        if not row: raise HTTPException(404, '메시지를 찾지 못했어요.')
        return row

    def view(row):
        r = dict(row)
        r['has_image'] = bool(r.pop('image'))
        r.pop('fingerprint', None)
        r.pop('uid', None)
        r.pop('usage', None)
        if r['answer']: r['answer'] = json.loads(r['answer'])
        return r

    def reserve(c, uid):
        now = time.time()
        if c.execute("SELECT 1 FROM turns WHERE uid=? AND status='pending'", (uid,)).fetchone():
            raise HTTPException(409, '이전 답변을 받고 있어요. 잠시만 기다려 주세요.')
        if c.execute("SELECT COUNT(*) FROM turns WHERE status='pending'").fetchone()[0] >= 4:
            raise HTTPException(429, '잠시 요청이 몰렸어요. 조금 뒤 다시 보내 주세요.')
        # One shared daily budget for this personal pilot, including explicit retries.
        cap = int(os.getenv('GYEOTE_DAILY_LIMIT', '100'))
        if c.execute('SELECT COUNT(*) FROM attempts WHERE created>?', (now-86400,)).fetchone()[0] >= cap:
            raise HTTPException(429, '오늘의 AI 요청 한도에 도달했어요. 내일 다시 이용해 주세요.')
        c.execute('INSERT INTO attempts VALUES(?,?)', (uid, now))

    async def process(tid):
        try:
            with db.connect() as c:
                row = c.execute('SELECT * FROM turns WHERE id=?', (tid,)).fetchone()
                previous = list(c.execute("SELECT text, answer FROM turns WHERE room=? AND status='done' AND created<? ORDER BY created DESC LIMIT 8", (row['room'], row['created'])))[::-1]
                # Bounded, structured history. Never loads another room or account.
                history = [{'text': r['text'][:4000], 'answer': r['answer'][:6000]} for r in previous]
                image = {'type': row['image_type'], 'data': base64.b64encode(row['image']).decode()} if row['image'] else None
            answer, usage = await ai.answer(row['text'], image, row['mode'], history)
            with db.connect() as c:
                c.execute("UPDATE turns SET status='done', answer=?, usage=?, error=NULL WHERE id=?", (json.dumps(answer, ensure_ascii=False), json.dumps(usage), tid))
        except asyncio.CancelledError:
            with db.connect() as c:
                c.execute("UPDATE turns SET status='failed', error='서버 연결이 중단됐어요. 다시 시도해 주세요.' WHERE id=?", (tid,))
            raise
        except Exception as e:
            error = str(e) if isinstance(e, ProviderError) else '답변을 저장하지 못했어요. 다시 시도해 주세요.'
            with db.connect() as c:
                c.execute("UPDATE turns SET status='failed', error=? WHERE id=?", (error, tid))

    def launch(tid):
        task = asyncio.create_task(process(tid))
        jobs.add(task)
        task.add_done_callback(jobs.discard)

    def local_device(request):
        return (request.client.host in ('127.0.0.1', '::1') and
                request.url.hostname in ('localhost', '127.0.0.1', '::1') and
                not request.headers.get('cf-connecting-ip') and
                not request.headers.get('x-forwarded-for'))

    @app.post('/api/session')
    async def session(request: Request, response: Response, body: Access = Access()):
        try: uid = who(request)
        except HTTPException:
            if not local_device(request):
                if not body.access_code:
                    raise HTTPException(401, '처음 연결할 때는 접속 코드가 필요해요.')
                throttle(('access', request.client.host), 8, 600)
                if not secrets.compare_digest(body.access_code, access_code):
                    raise HTTPException(401, '접속 코드를 확인해 주세요.')
            throttle(('signup', request.client.host), 12, 3600)
            uid = uuid.uuid4().hex
            with db.connect() as c:
                c.execute("INSERT INTO users VALUES(?, '나', 'easy')", (uid,))
                c.execute('INSERT INTO rooms VALUES(?,?,?,?)', (uuid.uuid4().hex, uid, '첫 대화', time.time()))
                set_session(c, uid, response, request)
        with db.connect() as c:
            profile = dict(c.execute('SELECT name, mode FROM users WHERE id=?', (uid,)).fetchone())
        return {'profile': profile, 'ai_ready': bool(getattr(ai, 'key', True)), 'access_code': access_code if local_device(request) else None}

    @app.put('/api/profile')
    async def profile(body: Profile, request: Request):
        uid = who(request)
        if not body.name.strip(): raise HTTPException(422, '이름을 입력해 주세요.')
        with db.connect() as c: c.execute('UPDATE users SET name=?, mode=? WHERE id=?', (body.name.strip(), body.mode, uid))
        return {'name': body.name.strip(), 'mode': body.mode}

    @app.get('/api/rooms')
    async def rooms(request: Request):
        uid = who(request)
        with db.connect() as c:
            return [dict(r) for r in c.execute('SELECT id,title,created FROM rooms WHERE uid=? ORDER BY created DESC', (uid,))]

    @app.post('/api/rooms')
    async def new_room(request: Request):
        uid = who(request)
        throttle(('room', uid), 20, 3600)
        rid = uuid.uuid4().hex
        with db.connect() as c: c.execute('INSERT INTO rooms VALUES(?,?,?,?)', (rid, uid, '새 대화', time.time()))
        return {'id': rid, 'title': '새 대화'}

    @app.get('/api/rooms/{rid}/turns')
    async def turns(rid: str, request: Request):
        uid = who(request)
        with db.connect() as c:
            own_room(c, rid, uid)
            return [view(r) for r in c.execute('SELECT * FROM (SELECT * FROM turns WHERE room=? ORDER BY created DESC LIMIT 200) ORDER BY created', (rid,))]

    @app.post('/api/rooms/{rid}/turns', status_code=202)
    async def send(rid: str, body: Send, request: Request):
        uid = who(request)
        if not body.text.strip() and not body.image: raise HTTPException(422, '문장을 적거나 사진을 골라 주세요.')
        image = None
        if body.image:
            try:
                image = base64.b64decode(body.image, validate=True)
                valid = (
                    body.image_type=='image/jpeg' and image.startswith(b'\xff\xd8\xff') or
                    body.image_type=='image/png' and image.startswith(b'\x89PNG\r\n\x1a\n') or
                    body.image_type=='image/webp' and image.startswith(b'RIFF') and image[8:12]==b'WEBP'
                )
                if not valid or len(image)>2*1024*1024: raise ValueError()
            except ValueError: raise HTTPException(422, 'JPEG·PNG·WebP 사진(2MB 이하)을 선택해 주세요.')
        fingerprint = digest(json.dumps([rid, body.text.strip(), body.image_type, body.image]))
        with db.connect() as c:
            own_room(c, rid, uid)
            existing = c.execute('SELECT * FROM turns WHERE id=?', (body.request_id,)).fetchone()
            if existing:
                if existing['uid'] != uid or existing['fingerprint'] != fingerprint: raise HTTPException(409, '요청 식별자가 다른 메시지와 겹쳤어요.')
                return view(existing)
            reserve(c, uid)
            mode = c.execute('SELECT mode FROM users WHERE id=?', (uid,)).fetchone()['mode']
            c.execute('INSERT INTO turns(id,uid,room,fingerprint,text,image,image_type,mode,status,created) VALUES(?,?,?,?,?,?,?,?,?,?)',
                      (body.request_id,uid,rid,fingerprint,body.text.strip(),image,body.image_type,mode,'pending',time.time()))
            c.execute("UPDATE rooms SET title=? WHERE id=? AND title IN ('새 대화', '첫 대화')", ((body.text.strip() or '사진에 대해 물어봤어요')[:26],rid))
            result = view(c.execute('SELECT * FROM turns WHERE id=?', (body.request_id,)).fetchone())
        launch(body.request_id)
        return result

    @app.get('/api/turns/{tid}')
    async def turn(tid: str, request: Request):
        uid = who(request)
        with db.connect() as c: return view(own_turn(c, tid, uid))

    @app.get('/api/turns/{tid}/image')
    async def attachment(tid: str, request: Request):
        uid = who(request)
        with db.connect() as c: row = own_turn(c, tid, uid)
        if not row['image']: raise HTTPException(404)
        return Response(bytes(row['image']), media_type=row['image_type'])

    @app.post('/api/turns/{tid}/retry', status_code=202)
    async def retry(tid: str, request: Request):
        uid = who(request)
        with db.connect() as c:
            row = own_turn(c, tid, uid)
            if row['status'] != 'failed': return view(row)
            reserve(c, uid)
            c.execute("UPDATE turns SET status='pending',error=NULL WHERE id=?", (tid,))
            result = view(c.execute('SELECT * FROM turns WHERE id=?', (tid,)).fetchone())
        launch(tid)
        return result

    @app.put('/api/turns/{tid}/progress')
    async def progress(tid: str, body: Progress, request: Request):
        uid = who(request)
        with db.connect() as c:
            row = own_turn(c, tid, uid)
            if not row['answer'] or body.completed > len(json.loads(row['answer'])['steps']): raise HTTPException(422, '단계를 확인해 주세요.')
            # A stale device cannot roll back already completed steps.
            value = max(row['completed'], body.completed)
            c.execute('UPDATE turns SET completed=? WHERE id=?', (value,tid))
        return {'completed': value}

    @app.post('/api/pairing')
    async def pairing(request: Request):
        uid = who(request)
        throttle(('pair_create', uid), 10, 3600)
        code = ''.join(secrets.choice('0123456789') for _ in range(8))
        with db.connect() as c:
            c.execute('DELETE FROM pairing WHERE uid=? OR expires<?', (uid,time.time()))
            c.execute('INSERT INTO pairing VALUES(?,?,?)', (digest(code),uid,time.time()+600))
        return {'code': code, 'expires_in': 600}

    @app.post('/api/pairing/claim')
    async def claim(body: Pair, request: Request, response: Response):
        who(request)
        throttle(('pair_claim', request.client.host), 5, 600)
        with db.connect() as c:
            pair = c.execute('SELECT * FROM pairing WHERE code=? AND expires>?', (digest(body.code), time.time())).fetchone()
            if not pair: raise HTTPException(400, '연결 코드를 확인해 주세요. 코드는 10분 동안 한 번 사용할 수 있어요.')
            c.execute('DELETE FROM pairing WHERE code=?', (digest(body.code),))
            c.execute('DELETE FROM sessions WHERE token=?', (digest(request.cookies.get(COOKIE,'')),))
            set_session(c, pair['uid'], response, request)
        return {'ok': True}

    @app.get('/')
    async def home(): return FileResponse(STATIC / 'index.html')

    app.mount('/', StaticFiles(directory=STATIC), name='static')
    return app

app = create_app()
