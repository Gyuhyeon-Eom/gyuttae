import asyncio, base64, os, tempfile
from pathlib import Path
os.environ['GYEOTE_CHAT_DB']=str(Path(tempfile.mkdtemp())/'unused.sqlite')
os.environ['GYEOTE_ACCESS_CODE']='test-access-code'
import httpx, pytest
from app.main import create_app
from app.provider import ProviderError

ANSWER=dict(summary='함께 확인해요.',voice='함께 확인해요.',goal='확인하려면',facts=[{'label':'입력','value':'확인됨'}],steps=[{'action':'눌러 주세요','detail':'보이는 버튼','question':'보이나요?'}],suggestions=[],question=None,caution=None)
class Fake:
    key=True
    def __init__(self,fail=False,gate=None): self.calls=0;self.fail=fail;self.gate=gate;self.history=[]
    async def answer(self,text,image,mode,history):
        self.calls+=1;self.history.append(history)
        if self.gate: await self.gate.wait()
        if self.fail: raise ProviderError('연결 실패')
        return ANSWER,{'model':'test-only'}
def client(app): return httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test')
async def init(c):
    assert (await c.post('/api/session',json={'access_code':'test-access-code'})).status_code==200
    return (await c.get('/api/rooms')).json()[0]['id']
async def drain(app): await asyncio.gather(*list(app.state.jobs))
def payload(n=1): return {'request_id':f'test-request-{n:016d}','text':'안녕하세요'}

@pytest.mark.asyncio
async def test_persistence_mode_history_progress(tmp_path):
    path=tmp_path/'db';fake=Fake();app=create_app(path,fake)
    async with client(app) as c:
        room=await init(c);await c.put('/api/profile',json={'name':'테스트','mode':'guided'})
        tid=(await c.post(f'/api/rooms/{room}/turns',json=payload())).json()['id'];await drain(app)
        assert (await c.get(f'/api/turns/{tid}')).json()['mode']=='guided'
        for n in (1,0): assert (await c.put(f'/api/turns/{tid}/progress',json={'completed':n})).json()['completed']==1
        assert (await c.put(f'/api/turns/{tid}/progress',json={'completed':2})).status_code==422
        await c.post(f'/api/rooms/{room}/turns',json=payload(2));await drain(app)
        assert fake.history[-1][0]['text']=='안녕하세요'
        cookies=c.cookies
    restarted=create_app(path,Fake())
    async with client(restarted) as c:
        c.cookies.update(cookies);saved=(await c.get(f'/api/rooms/{room}/turns')).json()
        assert len(saved)==2 and saved[0]['completed']==1
        assert (await c.post('/api/session',json={'access_code':'test-access-code'})).json()['profile']['mode']=='guided'

@pytest.mark.asyncio
async def test_double_send_inflight(tmp_path):
    gate=asyncio.Event();fake=Fake(gate=gate);app=create_app(tmp_path/'db',fake)
    async with client(app) as c:
        room=await init(c);path=f'/api/rooms/{room}/turns'
        a=await c.post(path,json=payload());b=await c.post(path,json=payload())
        assert a.json()['id']==b.json()['id']
        assert (await c.post(path,json={**payload(),'text':'다른 메시지'})).status_code==409
        assert (await c.post(path,json=payload(2))).status_code==409
        gate.set();await drain(app);assert fake.calls==1

@pytest.mark.asyncio
async def test_isolation_pairing(tmp_path):
    app=create_app(tmp_path/'db',Fake())
    async with client(app) as a,client(app) as b,client(app) as stranger:
        room=await init(a);await init(b);await init(stranger)
        image=base64.b64encode(b'\xff\xd8\xfftest').decode()
        tid=(await a.post(f'/api/rooms/{room}/turns',json={**payload(),'image':image,'image_type':'image/jpeg'})).json()['id'];await drain(app)
        for path in (f'/api/rooms/{room}/turns',f'/api/turns/{tid}',f'/api/turns/{tid}/image'): assert (await b.get(path)).status_code==404
        assert (await b.put(f'/api/turns/{tid}/progress',json={'completed':1})).status_code==404
        assert (await b.post(f'/api/turns/{tid}/retry')).status_code==404
        code=(await a.post('/api/pairing')).json()['code']
        assert (await b.post('/api/pairing/claim',json={'code':code})).status_code==200
        assert len((await b.get(f'/api/rooms/{room}/turns')).json())==1
        assert (await stranger.post('/api/pairing/claim',json={'code':code})).status_code==400
        assert (await b.get(f'/api/turns/{tid}/image')).headers['cache-control']=='no-store'

@pytest.mark.asyncio
async def test_explicit_retry(tmp_path):
    fake=Fake(fail=True);app=create_app(tmp_path/'db',fake)
    async with client(app) as c:
        room=await init(c);tid=(await c.post(f'/api/rooms/{room}/turns',json=payload())).json()['id'];await drain(app)
        assert (await c.get(f'/api/turns/{tid}')).json()['status']=='failed'
        fake.fail=False
        await c.post(f'/api/turns/{tid}/retry');await drain(app)
        await c.post(f'/api/turns/{tid}/retry');await drain(app)
        assert fake.calls==2 and len((await c.get(f'/api/rooms/{room}/turns')).json())==1

@pytest.mark.asyncio
async def test_input_csrf_private_assets(tmp_path):
    app=create_app(tmp_path/'db',Fake())
    async with client(app) as c:
        room=await init(c)
        assert (await c.post('/api/rooms',headers={'Origin':'https://evil.example'})).status_code==403
        assert (await c.post(f'/api/rooms/{room}/turns',json={**payload(),'text':''})).status_code==422
        assert (await c.post(f'/api/rooms/{room}/turns',json={**payload(),'image':'%%%','image_type':'image/jpeg'})).status_code==422
        assert (await c.post(f'/api/rooms/{room}/turns',content=b'x'*3200001)).status_code==413
        for path in ('/.env','/data/chat.sqlite','/app/provider.py'): assert (await c.get(path)).status_code==404
        assert (await c.get('/manifest.webmanifest')).json()['display']=='standalone'

@pytest.mark.asyncio
async def test_cross_room_history_daily_cap(tmp_path,monkeypatch):
    monkeypatch.setenv('GYEOTE_DAILY_LIMIT','2');fake=Fake();app=create_app(tmp_path/'db',fake)
    async with client(app) as c:
        room=await init(c);await c.post(f'/api/rooms/{room}/turns',json=payload());await drain(app)
        other=(await c.post('/api/rooms')).json()['id'];await c.post(f'/api/rooms/{other}/turns',json=payload(2));await drain(app)
        assert fake.history[-1]==[]
        assert (await c.post(f'/api/rooms/{other}/turns',json=payload(3))).status_code==429
