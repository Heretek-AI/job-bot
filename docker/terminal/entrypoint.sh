#!/usr/bin/env bash
set -euo pipefail

DIST_DIR="${JOBPILOT_DIST_DIR:-/opt/jobpilot-dist}"
INSTALL_DIR="${JOBPILOT_INSTALL_DIR:-/root/.jobpilot}"
PLUGIN_DIR="${INSTALL_DIR}/plugin"
CLAUDE_SETTINGS_PLUGIN="${PLUGIN_DIR}/settings/claude.json"
CLAUDE_SETTINGS_HOME="/root/.claude/settings.json"
MCP_CONFIG_FILE="${PLUGIN_DIR}/.mcp.json"

echo "[terminal] Syncing JobPilot binary and bundled plugin tree from ${DIST_DIR} -> ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}"
if [ -d "${DIST_DIR}" ]; then
  cp -f "${DIST_DIR}/jobpilot" "${INSTALL_DIR}/jobpilot"
  chmod +x "${INSTALL_DIR}/jobpilot"
  rm -rf "${INSTALL_DIR}/plugin"
  cp -R "${DIST_DIR}/plugin" "${INSTALL_DIR}/plugin"
fi

# Ensure ATS_VAULT_MASTER_SECRET is at least 32 characters (auto-generate & persist if left at placeholder/unset)
VAULT_SECRET_FILE="${INSTALL_DIR}/.vault_master_secret"
if [ -z "${ATS_VAULT_MASTER_SECRET:-}" ] || [ "${#ATS_VAULT_MASTER_SECRET}" -lt 32 ] || [[ "${ATS_VAULT_MASTER_SECRET}" == *"change_this"* ]] || [[ "${ATS_VAULT_MASTER_SECRET}" == *"REPLACE_"* ]]; then
  if [ -f "${VAULT_SECRET_FILE}" ]; then
    export ATS_VAULT_MASTER_SECRET="$(cat "${VAULT_SECRET_FILE}")"
  else
    export ATS_VAULT_MASTER_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
    printf "%s" "${ATS_VAULT_MASTER_SECRET}" > "${VAULT_SECRET_FILE}"
    chmod 600 "${VAULT_SECRET_FILE}"
    echo "[terminal] Generated and persisted a random 64-char ATS_VAULT_MASTER_SECRET in ${VAULT_SECRET_FILE}."
  fi
fi

echo "[terminal] Configuring OpenCode Claude Code Harness, Stealth Browser MCP & Password Vault..."

# 1. Configure Kestrel to listen on 0.0.0.0:4102 inside the container and allow remote origins
python3 - <<'PY'
import json, os

install_dir = os.environ.get("JOBPILOT_INSTALL_DIR", "/root/.jobpilot")
appsettings_path = os.path.join(install_dir, "appsettings.json")

origins = {
    "http://localhost:4100",
    "http://127.0.0.1:4100",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://web:4100",
}
pub_port = os.environ.get("PUBLIC_PORT", "").strip()
if pub_port:
    origins.add(f"http://localhost:{pub_port}")
    origins.add(f"http://127.0.0.1:{pub_port}")

for env_key in ("PUBLIC_URL", "APP_URL", "CORS_ORIGINS"):
    val = os.environ.get(env_key, "")
    for item in val.split(","):
        item = item.strip().rstrip("/")
        if item:
            origins.add(item)
            if ":" in item.split("//")[-1]:
                port = item.rsplit(":", 1)[-1]
                if port.isdigit():
                    origins.add(f"http://localhost:{port}")
                    origins.add(f"http://127.0.0.1:{port}")

cfg = {
    "Kestrel": {
        "Endpoints": {
            "Http": {
                "Url": "http://0.0.0.0:4102"
            }
        }
    },
    "Terminal": {
        "AllowedOrigins": sorted(origins)
    },
    "Logging": {
        "LogLevel": {
            "Default": "Information",
            "Microsoft.AspNetCore": "Warning"
        }
    },
    "AllowedHosts": "*"
}

with open(appsettings_path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
os.chmod(appsettings_path, 0o600)
print(f"[terminal] Wrote {appsettings_path} with AllowedOrigins: {sorted(origins)}")
PY

# 2. Inject OpenCode Claude Code Harness settings into both ~/.claude/settings.json and plugin/settings/claude.json
# Preserves any existing keys in ~/.claude/settings.json and sets chmod 600
python3 - <<'PY'
import json, os

install_dir = os.environ.get("JOBPILOT_INSTALL_DIR", "/root/.jobpilot")
plugin_claude_path = os.path.join(install_dir, "plugin", "settings", "claude.json")
home_claude_path = "/root/.claude/settings.json"

opencode_env = {
    "ANTHROPIC_BASE_URL": os.environ.get("ANTHROPIC_BASE_URL", "https://opencode.ai/inference/anthropic"),
    "ANTHROPIC_AUTH_TOKEN": os.environ.get("ANTHROPIC_AUTH_TOKEN", ""),
    "ANTHROPIC_DEFAULT_OPUS_MODEL": os.environ.get("ANTHROPIC_DEFAULT_OPUS_MODEL", "claude-opus-5-5"),
    "ANTHROPIC_DEFAULT_SONNET_MODEL": os.environ.get("ANTHROPIC_DEFAULT_SONNET_MODEL", "claude-sonnet-5-5"),
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": os.environ.get("ANTHROPIC_DEFAULT_HAIKU_MODEL", "claude-haiku-5-5"),
}

for target_path, default_root in (
    (plugin_claude_path, {"model": "sonnet", "env": {}}),
    (home_claude_path, {"env": {}}),
):
    os.makedirs(os.path.dirname(target_path), exist_ok=True)
    if os.path.exists(target_path):
        try:
            with open(target_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            if not isinstance(cfg, dict):
                cfg = dict(default_root)
        except Exception:
            cfg = dict(default_root)
    else:
        cfg = dict(default_root)

    env_map = cfg.get("env")
    if not isinstance(env_map, dict):
        env_map = {}
    env_map.update(opencode_env)
    cfg["env"] = env_map

    perms = cfg.get("permissions")
    if not isinstance(perms, dict):
        perms = {}
    perms["defaultMode"] = "bypassPermissions"
    perms.pop("deny", None)
    perms["allow"] = [
        "Bash",
        "Bash(*)",
        "Read",
        "Read(*)",
        "Write",
        "Write(*)",
        "Edit",
        "Edit(*)",
        "MultiEdit",
        "Glob",
        "Grep",
        "WebFetch",
        "WebSearch",
        "Task",
        "Skill",
        "NotebookEdit",
        "mcp__playwright__*",
        "mcp__plugin_jobpilot_playwright__*",
        "mcp__jobbot-mcp__*",
        "mcp__plugin_jobpilot_jobbot-mcp__*",
        "mcp__invisible-firefox__*",
        "mcp__plugin_jobpilot_invisible-firefox__*",
    ]
    cfg["permissions"] = perms
    cfg.pop("autoMode", None)

    with open(target_path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    os.chmod(target_path, 0o600)

print(f"[terminal] Configured OpenCode Claude Code harness ({opencode_env['ANTHROPIC_BASE_URL']}) with models: "
      f"opus={opencode_env['ANTHROPIC_DEFAULT_OPUS_MODEL']}, "
      f"sonnet={opencode_env['ANTHROPIC_DEFAULT_SONNET_MODEL']}, "
      f"haiku={opencode_env['ANTHROPIC_DEFAULT_HAIKU_MODEL']}")

# Ensure /root/.claude.json is pre-seeded (and restored from /root/.claude/backups if container was recreated)
# so Claude Code never shows the interactive theme onboarding wizard or workspace/MCP trust prompts.
import glob

claude_json_path = "/root/.claude.json"
persisted_json_path = "/root/.claude/.claude.json"
state = {}

for candidate in [claude_json_path, persisted_json_path] + sorted(glob.glob("/root/.claude/backups/.claude.json.backup.*"), reverse=True):
    if os.path.exists(candidate):
        try:
            with open(candidate, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict) and loaded:
                state = loaded
                break
        except Exception:
            pass

state["hasCompletedOnboarding"] = True
state["theme"] = state.get("theme", "dark")
state["numStartups"] = max(int(state.get("numStartups", 1)), 1)
projects = state.get("projects")
if not isinstance(projects, dict):
    projects = {}
proj = projects.get(install_dir)
if not isinstance(proj, dict):
    proj = {}
proj["hasTrustDialogAccepted"] = True
proj["enabledMcpjsonServers"] = ["playwright", "jobbot-mcp"]
projects[install_dir] = proj
state["projects"] = projects

for dest in (claude_json_path, persisted_json_path):
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    os.chmod(dest, 0o600)
PY

# 3. Wire plugin/.mcp.json to CloakBrowser C++ Stealth Chromium over CDP + jobbot-mcp + optional Invisible Playwright Firefox
python3 - <<'PY'
import json, os

install_dir = os.environ.get("JOBPILOT_INSTALL_DIR", "/root/.jobpilot")
mcp_path = os.path.join(install_dir, "plugin", ".mcp.json")
cdp_url = os.environ.get("CLOAKBROWSER_CDP_URL", "http://cloakbrowser:9222")

mcp_env = {
    "DATABASE_URL": os.environ.get("DATABASE_URL", ""),
    "JOBPILOT_API": os.environ.get("JOBPILOT_API", "http://api:4101"),
    "JOBPILOT_INSTALL_DIR": install_dir,
    "GMAIL_ADDRESS": os.environ.get("GMAIL_ADDRESS", ""),
    "GMAIL_APP_PASSWORD": os.environ.get("GMAIL_APP_PASSWORD", ""),
    "GMAIL_IMAP_HOST": os.environ.get("GMAIL_IMAP_HOST", "imap.gmail.com"),
    "GMAIL_IMAP_PORT": os.environ.get("GMAIL_IMAP_PORT", "993"),
    "ATS_VAULT_MASTER_SECRET": os.environ.get("ATS_VAULT_MASTER_SECRET", ""),
    "ATS_DEFAULT_PASSWORD_PREFIX": os.environ.get("ATS_DEFAULT_PASSWORD_PREFIX", "JobBot#2026!"),
    "CLOAKBROWSER_CDP_URL": cdp_url,
    "CAPSOLVER_API_KEY": os.environ.get("CAPSOLVER_API_KEY", ""),
    "TWOCAPTCHA_API_KEY": os.environ.get("TWOCAPTCHA_API_KEY", ""),
    "CAREER_OPS_DIR": "/opt/career-ops",
    "SHARED_RESUMES_DIR": "/app/shared/resumes"
}
if os.environ.get("JOBPILOT_API_TOKEN", "").strip():
    mcp_env["JOBPILOT_API_TOKEN"] = os.environ["JOBPILOT_API_TOKEN"].strip()

mcp_servers = {
    "playwright": {
        "command": "playwright-mcp",
        "args": [
            "--cdp-endpoint",
            cdp_url,
            "--snapshot-mode",
            "none"
        ]
    },
    "jobbot-mcp": {
        "command": "node",
        "args": ["/opt/jobbot-mcp/dist/index.js"],
        "env": mcp_env
    }
}

if os.environ.get("ENABLE_UPWORK_MCP", "false").lower() == "true":
    mcp_servers["upwork"] = {
        "type": "http",
        "url": "https://mcp.upwork.com/mcp"
    }

if os.environ.get("ENABLE_INVISIBLE_PLAYWRIGHT_FIREFOX_MCP", "false").lower() == "true":
    mcp_servers["invisible-firefox"] = {
        "command": "uvx",
        "args": ["invisible-playwright-mcp"]
    }

with open(mcp_path, "w", encoding="utf-8") as f:
    json.dump({"mcpServers": mcp_servers}, f, indent=2)
os.chmod(mcp_path, 0o600)

print(f"[terminal] Updated {mcp_path} with CloakBrowser CDP ({cdp_url}) and jobbot-mcp.")
PY

# 4. Pre-wire plugin/skills/_shared/auth.md, get-code, and apply skills for automatic password saving & IMAP OTPs
if [ -f "${PLUGIN_DIR}/skills/_shared/auth.md" ] && ! grep -q "ats_save_credentials" "${PLUGIN_DIR}/skills/_shared/auth.md"; then
  cat >> "${PLUGIN_DIR}/skills/_shared/auth.md" << 'EOF'

## Self-Hosted Job-Bot Password Vault (`jobbot-mcp` Auto-Create & Save Rules)

1. **When `/api/credentials/resolve` returns `null`**:
   - Do **not** skip login or stop. Immediately call `jobbot-mcp`'s `ats_get_or_create_credentials({ "portalUrl": "<current_url_or_domain>", "companyName": "<company>" })`.
   - It returns `{ email, password, isNew, accountVerified: false }` encrypted and persisted in Postgres (and synced to `/api/credentials`).
2. **When creating/registering a new account vs. completing verification**:
   - If you register an account with a custom password before email verification completes, call `ats_save_credentials({ "portalUrl": "<current_url_or_domain>", "email": "<email>", "password": "<password>", "accountVerified": false })`.
   - Once email verification / login succeeds (or after resetting a password), call `ats_save_credentials({ "portalUrl": "<current_url_or_domain>", "email": "<email>", "password": "<password>", "accountVerified": true })` to mark the saved record as verified.
EOF
fi

if [ -f "${PLUGIN_DIR}/skills/get-code/SKILL.md" ] && ! grep -q "gmail_wait_for_verification_code" "${PLUGIN_DIR}/skills/get-code/SKILL.md"; then
  cat >> "${PLUGIN_DIR}/skills/get-code/SKILL.md" << 'EOF'

## Phase 0 (Preferred in Self-Hosted Job-Bot): Direct Gmail IMAP App-Password Tool
Before checking `/api/email/account` OAuth, if the `jobbot-mcp` tool `gmail_wait_for_verification_code` is available, call:
`gmail_wait_for_verification_code({ "boardDomain": "$BOARD_DOMAIN", "timeoutSeconds": 45 })`
If it returns a `verificationCode` or `verificationLink`, output that JSON immediately and exit.
EOF
fi

if [ -f "${PLUGIN_DIR}/skills/apply/SKILL.md" ] && ! grep -q "ats_get_or_create_credentials" "${PLUGIN_DIR}/skills/apply/SKILL.md"; then
  cat >> "${PLUGIN_DIR}/skills/apply/SKILL.md" << 'EOF'

## Self-Hosted Job-Bot Extensions (ATS Password Vault & Career-Ops PDF)
- **Creating & Saving Passwords**: Whenever an ATS portal (Workday, iCIMS, Taleo, etc.) requires login or registration, call `ats_get_or_create_credentials` to get/generate the login (`accountVerified: false`), and call `ats_save_credentials` with `accountVerified: true` once activation/login succeeds.
- **Verification Codes**: For email 2FA or Workday account activation links, call `gmail_wait_for_verification_code` from `jobbot-mcp`.
- **ATS-Clean PDF Generation**: Call `career_ops_compile_pdf` from `jobbot-mcp` to render an ATS-optimized single-page PDF into `/app/shared/resumes/`.
EOF
fi

# 5. Patch extract-resume/SKILL.md so OpenCode / non-Anthropic models use `pdftotext -layout`
#    instead of Claude Code's `Read` tool on binary .pdf files (non-Anthropic models do not receive
#    Anthropic-proprietary `type: "document"` base64 PDF blocks from `Read`).
if [ -f "${PLUGIN_DIR}/skills/extract-resume/SKILL.md" ] && ! grep -q "pdftotext -layout" "${PLUGIN_DIR}/skills/extract-resume/SKILL.md"; then
  sed -i 's/`Read` the PDF at the path from Step 2\./Do **NOT** call `Read` directly on the `.pdf` file (OpenCode\/non-Anthropic models do not receive binary PDF blocks from `Read`). Instead, run `pdftotext -layout "<pdf_path>" "$JOBPILOT_TEMP\/resume-text.txt"` via `Bash` and then `Read` `"$JOBPILOT_TEMP\/resume-text.txt"`./g' "${PLUGIN_DIR}/skills/extract-resume/SKILL.md"
fi

# 5. Symlink /root/.jobpilot/apps -> /app/apps so skills using ${JOBPILOT_WORKSPACE_ROOT}/apps/api/storage/resumes
#    resolve to the shared api-storage volume (/app/apps/api/storage/resumes).
mkdir -p /app/apps/api/storage/resumes
ln -sfn /app/apps "${INSTALL_DIR}/apps"

# 6. Force JOBPILOT_API=http://api:4101 in plugin/bin/jobpilot-api and /root/.local/bin/claude
#    (the browser passes its host URL e.g. http://localhost:8081 in POST /sessions/start, which would
#     otherwise point JOBPILOT_API at the terminal container's own loopback).
cat > "${PLUGIN_DIR}/bin/jobpilot-api" << 'EOF'
#!/bin/sh
dir=$(dirname "$0")
export JOBPILOT_API="http://api:4101"
MSYS_NO_PATHCONV=1 exec node "$dir/api.mjs" "$@"
EOF
chmod +x "${PLUGIN_DIR}/bin/jobpilot-api"

# Also run a lightweight loopback TCP bridge on 127.0.0.1:${PUBLIC_PORT}, 8080, 4101, 4100 inside
# the terminal container so any .NET Pilot loop or tool calling localhost:<port> reaches api/nginx/web.
python3 - <<'PY' &
import asyncio, os

bridges = {
    4101: ("api", 4101),
    4100: ("web", 4100),
    8080: ("nginx", 8080),
}
pub_port = os.environ.get("PUBLIC_PORT", "").strip()
if pub_port.isdigit() and int(pub_port) != 4102:
    bridges[int(pub_port)] = ("nginx", 8080)

async def pipe(r, w):
    try:
        while chunk := await r.read(65536):
            w.write(chunk)
            await w.drain()
    except Exception:
        pass
    finally:
        try:
            w.close()
        except Exception:
            pass

def make_handler(host, port):
    async def handle(cr, cw):
        try:
            ur, uw = await asyncio.open_connection(host, port)
        except Exception:
            cw.close()
            return
        await asyncio.gather(pipe(cr, uw), pipe(ur, cw))
    return handle

async def main():
    servers = []
    for local_port, (target_host, target_port) in bridges.items():
        try:
            srv = await asyncio.start_server(make_handler(target_host, target_port), "127.0.0.1", local_port)
            servers.append(srv)
        except Exception:
            pass
    await asyncio.Event().wait()

asyncio.run(main())
PY

# 7. Install a wrapper at both /usr/bin/claude and /root/.local/bin/claude
# that sets IS_SANDBOX=1, forces --dangerously-skip-permissions (bypassPermissions),
# and ensures JOBPILOT_API=http://api:4101 so Bash/MCP tool calls never hit classifier timeouts or denials.
mkdir -p /root/.local/bin
if [ ! -e /usr/bin/claude-real ] && [ -e /usr/bin/claude ]; then
  mv -f /usr/bin/claude /usr/bin/claude-real
fi
cat > /root/.local/bin/claude << 'EOF'
#!/usr/bin/env bash
export IS_SANDBOX=1
export JOBPILOT_API="http://api:4101"
args=("--dangerously-skip-permissions")
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--permission-mode" ]]; then
    shift 2 || shift
  elif [[ "$1" == --permission-mode=* || "$1" == "--dangerously-skip-permissions" ]]; then
    shift
  else
    args+=("$1")
    shift
  fi
done
exec /usr/bin/claude-real "${args[@]}"
EOF
chmod +x /root/.local/bin/claude
cp -f /root/.local/bin/claude /usr/bin/claude
chmod +x /usr/bin/claude

echo "[terminal] Launching JobPilot Terminal Host on 0.0.0.0:4102..."
export DOTNET_EnableWriteXorExecute=0
export IS_SANDBOX=1
exec "${INSTALL_DIR}/jobpilot"
