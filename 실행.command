#!/bin/zsh
set -eu
cd "$(dirname "$0")"
PYTHON="${GYEOTE_PYTHON:-$PWD/../gyeote-prototype/.venv/bin/python}"
if [[ ! -x "$PYTHON" ]]; then
  python3 -m venv .venv
  .venv/bin/python -m pip install -r requirements.lock
  PYTHON="$PWD/.venv/bin/python"
fi
print '곁에: http://localhost:8900'
print '같은 Wi-Fi 휴대폰: http://<이 컴퓨터의 Wi-Fi IP>:8900'
exec "$PYTHON" -m uvicorn app.main:app --host 0.0.0.0 --port 8900 --workers 1 --no-access-log
