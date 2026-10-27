#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${JOBPILOT_INSTALL_DIR:-/root/.jobpilot}"
PLUGIN_DIR="${INSTALL_DIR}/plugin"
CLAUDE_SETTINGS_PLUGIN="${PLUGIN_DIR}/settings/claude.json"
CLAUDE_SETTINGS_HOME="/root/.claude/settings.json"
MCP_CONFIG_FILE="${PLUGIN_DIR}/.mcp.json"

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
print(f"[terminal] Wrote {appsettings_path} with AllowedOrigins: {sorted(origins)}")
PY

# 2. Inject OpenCode Claude Code Harness settings into both ~/.claude/settings.json and plugin/settings/claude.json
# Reference: https://opencode.ai/v2/docs/console/harnesses/claude-code
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

if os.path.exists(plugin_claude_path):
    with open(plugin_claude_path, "r", encoding="utf-8") as f:
        plugin_cfg = json.load(f)
else:
    plugin_cfg = {"model": "sonnet", "env": {}}

plugin_cfg.setdefault("env", {}).update(opencode_env)
os.makedirs(os.path.dirname(plugin_claude_path), exist_ok=True)
with open(plugin_claude_path, "w", encoding="utf-8") as f:
    json.dump(plugin_cfg, f, indent=2)

os.makedirs(os.path.dirname(home_claude_path), exist_ok=True)
with open(home_claude_path, "w", encoding="utf-8") as f:
    json.dump({"env": opencode_env}, f, indent=2)

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
        "command": "npx",
        "args": [
            "@playwright/mcp@latest",
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

if os.environ.get("ENABLE_INVISIBLE_PLAYWRIGHT_FIREFOX_MCP", "true").lower() == "true":
    mcp_servers["invisible-firefox"] = {
        "command": "uvx",
        "args": ["invisible-playwright-mcp"]
    }

with open(mcp_path, "w", encoding="utf-8") as f:
    json.dump({"mcpServers": mcp_servers}, f, indent=2)

print(f"[terminal] Updated {mcp_path} with CloakBrowser CDP ({cdp_url}) and jobbot-mcp.")
PY

# 4. Pre-wire plugin/skills/_shared/auth.md, get-code, and apply skills for automatic password saving & IMAP OTPs
if [ -f "${PLUGIN_DIR}/skills/_shared/auth.md" ] && ! grep -q "ats_save_credentials" "${PLUGIN_DIR}/skills/_shared/auth.md"; then
  cat >> "${PLUGIN_DIR}/skills/_shared/auth.md" << 'EOF'

## Self-Hosted Job-Bot Password Vault (`jobbot-mcp` Auto-Create & Save Rules)

1. **When `/api/credentials/resolve` returns `null`**:
   - Do **not** skip login or stop. Immediately call `jobbot-mcp`'s `ats_get_or_create_credentials({ "portalUrl": "<current_url_or_domain>", "companyName": "<company>" })`.
   - It returns `{ email, password, isNew }` encrypted and persisted in Postgres (and synced to `/api/credentials`).
2. **Whenever you create/register a new account, verify an account, or reset a password**:
   - Always call `jobbot-mcp`'s `ats_save_credentials({ "portalUrl": "<current_url_or_domain>", "email": "<email>", "password": "<password>", "accountVerified": true })` so the credential is permanently saved in both the Postgres vault and the JobPilot Web UI!
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
- **Creating & Saving Passwords**: Whenever an ATS portal (Workday, iCIMS, Taleo, etc.) requires login or registration, call `ats_get_or_create_credentials` to get/generate the login, and call `ats_save_credentials` whenever a password is created, updated, or verified.
- **Verification Codes**: For email 2FA or Workday account activation links, call `gmail_wait_for_verification_code` from `jobbot-mcp`.
- **ATS-Clean PDF Generation**: Call `career_ops_compile_pdf` from `jobbot-mcp` to render an ATS-optimized single-page PDF into `/app/shared/resumes/`.
EOF
fi

echo "[terminal] Launching JobPilot Terminal Host on 0.0.0.0:4102..."
exec "${INSTALL_DIR}/jobpilot"
