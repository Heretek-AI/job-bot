#!/usr/bin/env bash
set -euo pipefail

INTERNAL_CDP_PORT=9223
EXTERNAL_CDP_PORT="${CDP_PORT:-9222}"

echo "[cloakbrowser] Starting C++-patched stealth Chromium with persistent context (/data/profile) on internal CDP port ${INTERNAL_CDP_PORT}..."

python3 - <<'PY' &
import os, time
from cloakbrowser import launch_persistent_context

proxy = os.environ.get("CLOAK_PROXY") or None
timezone = os.environ.get("TZ") or "America/New_York"
locale = os.environ.get("CLOAK_LOCALE") or "en-US"

args = [
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=9223",
    "--remote-allow-origins=*",
    "--fingerprint-storage-quota=5000",
    "--password-store=basic",
    "--enable-features=PasswordImport",
    "--no-sandbox",
    "--disable-dev-shm-usage",
]

ctx = launch_persistent_context(
    "/data/profile",
    headless=True,
    proxy=proxy,
    timezone=timezone,
    locale=locale,
    args=args,
)
print("[cloakbrowser] Stealth Chromium persistent context launched and listening on 127.0.0.1:9223", flush=True)
while True:
    time.sleep(3600)
PY

CLOAK_PID=$!

# Wait for internal CDP port to come up; exit non-zero if Chromium fails to bind
READY=0
for i in $(seq 1 30); do
  if ! kill -0 "${CLOAK_PID}" 2>/dev/null; then
    echo "[cloakbrowser] ERROR: Chromium process exited prematurely." >&2
    exit 1
  fi
  if curl -fsS "http://127.0.0.1:${INTERNAL_CDP_PORT}/json/version" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done

if [ "${READY}" -ne 1 ]; then
  echo "[cloakbrowser] ERROR: Timed out waiting for Chromium CDP on 127.0.0.1:${INTERNAL_CDP_PORT}" >&2
  exit 1
fi

echo "[cloakbrowser] Bridging 0.0.0.0:${EXTERNAL_CDP_PORT} -> 127.0.0.1:${INTERNAL_CDP_PORT} for isolated browser-net..."
exec socat TCP-LISTEN:${EXTERNAL_CDP_PORT},fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:${INTERNAL_CDP_PORT}
