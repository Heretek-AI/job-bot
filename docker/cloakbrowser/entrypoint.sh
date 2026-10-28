#!/usr/bin/env bash
set -euo pipefail

INTERNAL_CDP_PORT=9223
EXTERNAL_CDP_PORT="${CDP_PORT:-9222}"

# Clean up any stale Chromium profile locks left behind by a previous container hostname/recreate
rm -f /data/profile/SingletonLock /data/profile/SingletonCookie /data/profile/SingletonSocket

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

echo "[cloakbrowser] Bridging 0.0.0.0:${EXTERNAL_CDP_PORT} -> 127.0.0.1:${INTERNAL_CDP_PORT} (Host-rewriting CDP & WebSocket proxy)..."
exec python3 -u - <<'PY'
import asyncio, os, re

INTERNAL_PORT = 9223
EXTERNAL_PORT = int(os.environ.get("CDP_PORT", "9222"))

async def pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while True:
            chunk = await reader.read(65536)
            if not chunk:
                break
            writer.write(chunk)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass

async def handle_client(client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter) -> None:
    up_reader = None
    up_writer = None
    try:
        up_reader, up_writer = await asyncio.open_connection("127.0.0.1", INTERNAL_PORT)
        while True:
            try:
                header_bytes = await client_reader.readuntil(b"\r\n\r\n")
            except Exception:
                break

            header_text = header_bytes.decode("latin1")
            lines = [l.rstrip("\r") for l in header_text.split("\r\n") if l.rstrip("\r")]
            if not lines:
                break

            caller_host = f"127.0.0.1:{EXTERNAL_PORT}"
            is_websocket = False
            req_content_length = 0
            new_lines = [lines[0]]

            for line in lines[1:]:
                lower = line.lower()
                if lower.startswith("host:"):
                    caller_host = line.split(":", 1)[1].strip()
                    new_lines.append(f"Host: 127.0.0.1:{INTERNAL_PORT}")
                else:
                    if lower.startswith("upgrade:") and "websocket" in lower:
                        is_websocket = True
                    elif lower.startswith("content-length:"):
                        try:
                            req_content_length = int(line.split(":", 1)[1].strip())
                        except Exception:
                            req_content_length = 0
                    new_lines.append(line)

            rewritten_headers = ("\r\n".join(new_lines) + "\r\n\r\n").encode("latin1")
            req_body = b""
            if req_content_length > 0:
                req_body = await client_reader.readexactly(req_content_length)

            up_writer.write(rewritten_headers + req_body)
            await up_writer.drain()

            if is_websocket:
                await asyncio.gather(
                    pipe(client_reader, up_writer),
                    pipe(up_reader, client_writer),
                )
                return

            resp_header_bytes = await up_reader.readuntil(b"\r\n\r\n")
            resp_header_text = resp_header_bytes.decode("latin1")
            resp_lines = [l.rstrip("\r") for l in resp_header_text.split("\r\n") if l.rstrip("\r")]

            length = None
            for line in resp_lines[1:]:
                if line.lower().startswith("content-length:"):
                    try:
                        length = int(line.split(":", 1)[1].strip())
                    except Exception:
                        length = None
                    break

            body = b""
            if length is not None:
                body = await up_reader.readexactly(length)
            else:
                body = await up_reader.read(65536)

            if b"127.0.0.1:9223" in body or b"localhost:9223" in body:
                target_bytes = caller_host.encode("latin1")
                body = body.replace(b"127.0.0.1:9223", target_bytes).replace(b"localhost:9223", target_bytes)
                resp_lines = [
                    f"Content-Length: {len(body)}" if l.lower().startswith("content-length:") else l
                    for l in resp_lines
                ]

            out_headers = ("\r\n".join(resp_lines) + "\r\n\r\n").encode("latin1")
            client_writer.write(out_headers + body)
            await client_writer.drain()
    except Exception:
        pass
    finally:
        if up_writer is not None:
            try:
                up_writer.close()
            except Exception:
                pass
        try:
            client_writer.close()
        except Exception:
            pass

async def main() -> None:
    server = await asyncio.start_server(handle_client, "0.0.0.0", EXTERNAL_PORT)
    async with server:
        await server.serve_forever()

asyncio.run(main())
PY
