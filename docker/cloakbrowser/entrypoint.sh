#!/usr/bin/env bash
set -euo pipefail

INTERNAL_CDP_PORT=9223
EXTERNAL_CDP_PORT="${CDP_PORT:-9222}"

echo "[cloakbrowser] Starting C++-patched stealth Chromium on internal CDP port ${INTERNAL_CDP_PORT}..."

python3 - <<'PY' &
import os, time
from cloakbrowser import launch

proxy = os.environ.get("CLOAK_PROXY") or None
timezone = os.environ.get("TZ") or "America/New_York"
locale = os.environ.get("CLOAK_LOCALE") or "en-US"

args = [
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9223",
    "--user-data-dir=/data/profile",
    "--password-store=basic",
    "--enable-features=PasswordImport",
    "--no-sandbox",
    "--disable-dev-shm-usage",
]

browser = launch(
    headless=True,
    proxy=proxy,
    timezone=timezone,
    locale=locale,
    args=args,
)
print("[cloakbrowser] Stealth Chromium launched with persistent /data/profile & password-store=basic on 127.0.0.1:9223", flush=True)
while True:
    time.sleep(3600)
PY

# Wait for internal CDP port to come up
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${INTERNAL_CDP_PORT}/json/version" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "[cloakbrowser] Bridging 0.0.0.0:${EXTERNAL_CDP_PORT} -> 127.0.0.1:${INTERNAL_CDP_PORT} for Docker network..."
exec socat TCP-LISTEN:${EXTERNAL_CDP_PORT},fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:${INTERNAL_CDP_PORT}
