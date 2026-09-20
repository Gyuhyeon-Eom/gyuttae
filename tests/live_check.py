"""Explicit paid end-to-end check with synthetic inputs; never runs under pytest."""
import base64,json,time,uuid,os
from pathlib import Path
import httpx
base=os.getenv('GYEOTE_TEST_URL','http://127.0.0.1:8901')
code=Path('data/access-code.txt').read_text().strip()
report={'base':base,'checks':[]}
def wait(c,tid):
    for _ in range(70):
        t=c.get('/api/turns/'+tid).json()
        if t.get('status')!='pending':
            assert t['status']=='done',t.get('error')
            return t
        time.sleep(2)
    raise RuntimeError('AI result timeout')
with httpx.Client(base_url=base,timeout=25) as a,httpx.Client(base_url=base,timeout=25) as b:
    assert a.post('/api/session').status_code==401
    for c in (a,b):
        r=c.post('/api/session',json={'access_code':code});assert r.status_code==200,r.text
        assert 'HttpOnly' in r.headers.get('set-cookie','')
    report['checks'].append('access gate, HttpOnly session')
    room=a.get('/api/rooms').json()[0]['id']
    text='기차가 30분 늦는다는 문자를 받았어요. 원래 10시 30분 출발, 12시 24분 도착이고 13시에 역 근처에서 약속이 있어요. 어떻게 하면 좋을까요?'
    payload={'request_id':uuid.uuid4().hex,'text':text}
    first=a.post(f'/api/rooms/{room}/turns',json=payload);assert first.status_code==202,first.text
    duplicate=a.post(f'/api/rooms/{room}/turns',json=payload);assert duplicate.json()['id']==first.json()['id']
    tid=first.json()['id']
    assert b.get('/api/turns/'+tid).status_code==404
    assert b.get(f'/api/rooms/{room}/turns').status_code==404
    assert a.post('/api/rooms',headers={'Origin':'https://invalid.example'}).status_code==403
    report['checks'].append('idempotent send, account isolation, CSRF')
    t=wait(a,tid);report['text']=t
    assert '6분' in json.dumps(t['answer'],ensure_ascii=False),t['answer']
    report['checks'].append('live time calculation: six minutes')
    assert a.put(f'/api/turns/{tid}/progress',json={'completed':1}).status_code==200
    assert a.get('/api/turns/'+tid).json()['completed']==1
    pair=a.post('/api/pairing').json()['code']
    assert b.post('/api/pairing/claim',json={'code':pair}).status_code==200
    assert len(b.get(f'/api/rooms/{room}/turns').json())>=1
    assert b.post('/api/pairing/claim',json={'code':pair}).status_code==400
    report['checks'].append('persisted progress, device pairing, one-time code')
    new=a.post('/api/rooms').json()['id']
    image=base64.b64encode(Path('verification/test-timetable.jpg').read_bytes()).decode()
    r=a.post(f'/api/rooms/{new}/turns',json={'request_id':uuid.uuid4().hex,'text':'이 사진의 도착 시각과 약속까지 남은 시간을 알려 주세요.','image':image,'image_type':'image/jpeg'})
    assert r.status_code==202,r.text
    photo=wait(a,r.json()['id']);report['photo']=photo
    assert '12' in json.dumps(photo['answer']) and '54' in json.dumps(photo['answer'])
    assert a.get('/api/turns/'+photo['id']+'/image').headers['content-type']=='image/jpeg'
    report['checks'].append('real image analysis, authenticated image download')
Path('verification/cloud-live.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({'checks':report['checks'],'text_summary':report['text']['answer']['summary'],'photo_summary':report['photo']['answer']['summary']},ensure_ascii=False))
