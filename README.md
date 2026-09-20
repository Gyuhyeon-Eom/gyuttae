# 곁에 · 실제 개인방 앱

공식 테스트 주소: **https://app.tridatum.co**

아이폰 Safari와 안드로이드 Chrome에서 같은 앱을 열고 홈 화면에 추가할 수 있는 PWA입니다.
화면과 API는 Cloudflare Worker, 대화·기기 세션·사진·완료 단계는 SQLite Durable Object에 저장합니다.
Mac 서버를 켜 둘 필요가 없습니다. 현재는 접속 코드를 아는 사람만 사용하는 개인 테스트 버전입니다.

## 지금 되는 것

- 직접 입력한 질문·문자를 Claude에 전달하고 실제 구조화 답변을 표시합니다.
- 사진을 첨부하면 브라우저가 크기를 줄인 뒤 서버가 실제 이미지 분석을 요청합니다.
- 쉽게 / 한 단계씩 / 자세히 설정은 서버에 저장되며 다음 답변에 적용합니다.
- 최근 8개 문답을 참고해 후속 질문에 답합니다. 과거 사진의 원본을 자동으로 다시 보내지는 않습니다.
- 대화방·기록·완료 단계는 새로고침해도 유지됩니다.
- 네트워크 오류에는 입력을 유지하고 같은 요청 ID로 재전송합니다. 이미 받은 요청은 중복 호출하지 않습니다.
- AI 연결 실패는 명시적으로 ‘다시 시도하기’를 눌러야 재요청합니다.
- 다른 기기는 8자리, 10분 유효, 1회 사용 연결 코드로 같은 개인방 계정에 연결합니다.
- 한국어 음성 낭독은 기기에서 지원하는 브라우저 음성 기능을 사용합니다.

## 접속과 설치

1. `https://app.tridatum.co`를 엽니다.
2. 처음에는 `data/access-code.txt`의 12자리 접속 코드를 입력합니다. 공유한 사람은 새 개인방을 만들 수 있으므로 초대하려는 테스트 사용자에게만 전달합니다.
3. 아이폰: Safari 공유 → 홈 화면에 추가. 안드로이드: Chrome 메뉴 → 앱 설치/홈 화면에 추가.
4. 기기간 기존 대화를 이어 보려면 설정 → 다른 기기에서 이어보기 → 연결 코드 만들기/입력.

접속 코드는 테스트 앱 진입용이며, 8자리 연결 코드는 특정 개인방의 접근 권한입니다.
Google 연결 전에는 기기 쿠키를 삭제하면 새 사용자로 취급됩니다. Google 연결을 마친 뒤에는 같은 계정으로 로그인해 기존 대화를 복구할 수 있습니다. Google 로그인은 아래 OAuth 설정 완료 후 활성화됩니다.
홈 화면 설치 시 브라우저와 저장 공간이 분리되는 기종에서는 연결 코드로 기존 대화를 가져오세요.
오프라인에서는 기본 화면만 열 수 있으며 새로운 AI 답변이나 서버 기록 조회에는 인터넷이 필요합니다.

## 구성

- `static/`: 포근한 디자인의 실제 클라이언트, 앱 아이콘, manifest, 서비스 워커
- `worker/index.js`: 배포 API, 권한·세션, SQLite 저장, 중복 방지, 처리 한도, Durable Object alarm 작업 처리
- `worker/ai-config.json`: 검증용 Python provider에서 가져온 프롬프트와 답변 스키마
- `wrangler.jsonc`: 앱 전용 배포·도메인·저장소 설정
- `app/`: 독립적으로 실행할 수 있는 로컬 FastAPI 구현. 배포 버전과 같은 API 경로를 사용합니다.
- `tests/test_app.py`: 로컬 저장·권한·재시도·중복·재시작·한도 테스트
- `tests/worker.test.mjs`: 배포 실행 환경의 인증·권한·입력·PWA 테스트 (유료 AI 호출 없음)
- `tests/live_check.py`: **실제 AI 비용이 발생하는** 문자·사진·저장·기기간 연결 통합 검증. 합성 데이터만 사용합니다.

## 모델과 데이터

현재 기본 모델은 `claude-sonnet-5`입니다. 실제 계정의 모델 목록과 API 호출을 확인했습니다.
첫 Haiku 시험에서 `13:00 - 12:54`를 잘못 해석한 응답이 있어 기본 모델을 변경했고,
Sonnet 문자·사진 검증에서는 6분으로 계산했습니다. 소수의 시험이며 일반적인 정확도를 보장하지 않습니다.
시간 계산 등 중요한 수치는 향후 별도 계산 로직과 평가셋으로 더 검증해야 합니다.

사용자가 보낸 글·사진 및 최근 대화 일부는 Anthropic에 전달됩니다.
API 키는 Worker secret으로 등록하며 브라우저나 정적 파일에 포함하지 않습니다.
서비스 워커는 공개 앱 파일만 캐시하고 API 응답·사진을 캐시하지 않습니다.

초기 테스트 한도는 **앱 전체 최근 24시간 100회**이며 재시도도 포함합니다.
사용자당 동시 1회, 앱 전체 대기 포함 4회로 제한합니다. 모델 요청 최대 75초, 최대 출력 2,200토큰입니다.
작업 중단 시 watchdog이 실패 처리하며 자동으로 유료 호출을 반복하지 않습니다.

## 개발과 배포

```sh
npm ci
cp .dev.vars.example .dev.vars
# .dev.vars의 두 값을 본인의 API 키와 접속 코드로 채웁니다.
npm run dev
# http://127.0.0.1:8901 — 실제 배포 환경을 로컬에서 실행
npm test
npm run deploy
```

`.dev.vars`에는 로컬 개발용 `ANTHROPIC_API_KEY`, `ACCESS_CODE`가 필요합니다.
배포용 비밀값은 `wrangler secret bulk`로 등록합니다. 키를 명령 인자·문서·로그에 적지 않습니다.
`MODEL`, `DAILY_LIMIT`는 `wrangler.jsonc`에서 조정합니다.
도메인은 앱 전용 `app.tridatum.co`이고 회사 홈페이지 설정과 파일은 별도입니다.

FastAPI 로컬 버전은 `실행.command` 또는 다음 명령을 사용합니다.

```sh
../gyeote-prototype/.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8900 --workers 1
../gyeote-prototype/.venv/bin/python -m pytest -q tests
```

로컬과 배포 DB는 별개입니다. 테스트 중 생성한 로컬 대화를 자동으로 클라우드에 업로드하지 않습니다.

## 다음 범위

가족 그룹방·구성원별 읽음/완료·초대 권한, 대화 삭제·보관 정책,
푸시 알림, 음성 입력, 스토어 배포는 아직 포함하지 않았습니다.
홈 화면 설치·카메라·음성의 실제 iOS/Android 기기 확인은 사용자 기기에서 한 번씩 진행해야 합니다.

공식 참고: [구조화 출력](https://platform.claude.com/docs/en/build-with-claude/structured-outputs),
[PWA 설치](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable),
[Cloudflare 사용자 도메인](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/),
[SQLite Durable Objects](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

## 2026-09-20 검증 결과

- FastAPI 핵심 테스트 6개, Cloudflare 실행 환경 테스트 4개 통과.
- 배포 주소에서 실제 문자·합성 사진 각각 1건의 응답, 중복 방지, 권한 차단, 기기 연결, 완료 단계 저장 확인.
- 로컬 서버 종료 후에도 배포 주소의 실제 AI 요청 완료.
- 배포 갱신 중 중단된 요청은 실패 표시 후 수동 재시도 대상으로 남습니다.
- 자세한 합성 입력과 출력: `verification/cloud-live.json`.

## 저장소에서 시작하기

```sh
git clone https://github.com/Gyuhyeon-Eom/gyuttae.git
cd gyuttae
```

비밀값, SQLite DB, 실행 로그와 실제 호출 결과 JSON은 Git에 포함하지 않습니다.
`verification/*.json`은 검증 스크립트를 실행하면 로컬에 생성됩니다.
Cloudflare 배포는 본인의 계정과 도메인에 맞게 `wrangler.jsonc`를 설정한 뒤 진행하세요.
현재 설정은 Tridatum 계정의 기존 앱을 대상으로 합니다.

Python 버전을 독립 실행하려면 다음과 같이 구성합니다.

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
cp .env.example .env
# .env에 API 키를 설정합니다.
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8900 --workers 1
```

Python 서버를 처음 실행하면 `data/access-code.txt`가 생성됩니다. Worker 통합 테스트는
이 파일의 접속 코드와 `.dev.vars`의 `ACCESS_CODE`를 일치시킨 뒤 실행합니다.
실제 AI 통합 테스트(`tests/live_check.py`)는 합성 질문·사진을 보내며 API 비용이 발생합니다.

## Google 로그인과 대화 복구 (Worker)

설정 → **계정과 대화 복구**에서 Google 계정을 연결하면 기존 대화와 설정이 그 계정에 연결됩니다.
새 기기에서는 접속 코드 없이 **Google로 로그인**해 같은 기록을 불러옵니다.
처음 가입하는 테스트 사용자는 접속 코드로 시작한 뒤 Google 계정을 연결합니다.
이미 다른 개인방에 연결된 Google 계정이면 자동으로 대화를 합치지 않고 안내합니다.
로그아웃과 모든 기기 로그아웃을 지원하며, Google 계정 자체 복구는 Google에서 진행합니다.

### 활성화

1. Google Cloud → Google Auth Platform에서 앱 브랜딩과 사용자를 설정합니다.
2. **웹 애플리케이션** OAuth 클라이언트를 생성합니다.
3. 승인된 리디렉션 URI: `https://app.tridatum.co/api/auth/google/callback`
4. 테스트 모드라면 사용할 Google 계정을 테스트 사용자로 등록합니다.
5. 아래 명령의 입력 프롬프트에서 각각 값을 붙여넣습니다. 비밀값을 명령 인자나 Git에 저장하지 않습니다.

```sh
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

두 설정이 모두 있어야 로그인 버튼이 활성화됩니다. 미설정 상태에서는 기존 접속 코드 방식이 유지됩니다.
로컬 Worker 검증은 `.dev.vars`에 두 값을 넣고 Google 클라이언트에
`http://localhost:8901/api/auth/google/callback`도 등록한 뒤 같은 localhost 주소로 접속합니다.
FastAPI 로컬 서버에는 Google 로그인이 없으므로 인증 개발에는 `npm run dev`를 사용합니다.

인증은 authorization code + PKCE, 10분짜리 브라우저 바인딩 state, nonce를 사용합니다.
ID 토큰은 Google 공개키로 서명·발급자·대상·만료·nonce·이메일 인증 상태를 확인합니다.
이메일 주소 대신 Google `sub`를 계정 식별자로 저장하며 Google 접근/갱신 토큰은 저장하지 않습니다.
로그인 세션은 HttpOnly 쿠키에 저장합니다. 모든 기기 로그아웃은 세션·기기 연결 코드·진행 중 연결을 폐기합니다.

```sh
npm run test:auth  # Node 24+, 실제 Google 접속이나 AI 비용 없음
```

인증 테스트는 계정 연결·복구·권한 충돌·콜백 재사용·로그아웃과 서명 토큰 검증을 확인합니다.
실제 Google 동의 화면과 iOS/Android 설치 앱에서의 로그인은 OAuth 자격 증명 등록 후 확인해야 합니다.
공식 참고: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect).
