#!/bin/zsh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  print 'Node.js 24 이상을 설치한 뒤 다시 실행해 주세요.'
  exit 1
fi
if [[ ! -f .dev.vars ]]; then
  cp .dev.vars.example .dev.vars
  print '.dev.vars에 개발용 API 키와 접속 코드를 설정한 뒤 다시 실행해 주세요.'
  exit 1
fi
if [[ ! -x node_modules/.bin/wrangler ]]; then
  npm ci
fi
print '곁에: http://localhost:8901'
print '휴대폰에서 사용하려면 https://app.tridatum.co 를 열어 주세요.'
exec npm run dev
