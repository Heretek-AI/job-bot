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
for env_key in ("PUBLIC_URL", "APP_URL", "CORS_ORIGINS"):
    val = os.environ.get(env_key, "")
    for item in val.split(","):
        item = item.strip().rstrip("/")
        if item:
            origins.add(item)

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

    with open(target_path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    os.chmod(target_path, 0o600)

print(f"[terminal] Configured OpenCode Claude Code harness ({opencode_env['ANTHROPIC_BASE_URL']}) with models: "
      f"opus={opencode_env['ANTHROPIC_DEFAULT_OPUS_MODEL']}, "
      f"sonnet={opencode_env['ANTHROPIC_DEFAULT_SONNET_MODEL']}, "
      f"haiku={opencode_env['ANTHROPIC_DEFAULT_HAIKU_MODEL']}")
PY

# 3. Wire plugin/.mcp.json to CloakBrowser C++ Stealth Chromium over CDP + jobbot-mcp + optional Invisible Playwright Firefox
python3 - <<'PY'
import json, os

install_dir = os.environ.get("JOBPILOT_INSTALL_DIR", "/root/.jobpilot")
mcp_path = os.path.join(install_dir, "plugin", ".mcp.json")
cdp_url = os.environ.get("CLOAKBROWSER_CDP_URL", "http://cloakbrowser:9222")

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
        "env": {
            "DATABASE_URL": os.environ.get("DATABASE_URL", ""),
            "JOBPILOT_API": os.environ.get("JOBPILOT_API", "http://api:4101"),
            "JOBPILOT_API_TOKEN": os.environ.get("JOBPILOT_API_TOKEN", ""),
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
    },
    "upwork": {
        "type": "http",
        "url": "https://mcp.upwork.com/mcp"
    }
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

echo "[terminal] Launching JobPilot Terminal Host on 0.0.0.0:4102..."
exec "${INSTALL_DIR}/jobpilot"
