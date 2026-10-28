# Job-Bot: Prepackaged Autonomous Job Application Stack

Everything comes **prebuilt and prewired** via GitHub Actions CI (`ghcr.io/heretek-ai/job-bot/*`). To run on any remote Docker server, you only need to configure `.env` and start the stack.

---

## 2-Step Remote Deployment

### 1. Create `.env`
Download `docker-compose.yml` and `.env.example` (or clone the repo) on your remote Docker machine:
```bash
cp .env.example .env
```
Fill in your **OpenCode** key/models, **Gmail App Password**, and generate a unique `SECRET_MASTER_KEY` (`openssl rand -base64 32`) in `.env`:
```dotenv
ANTHROPIC_BASE_URL=https://opencode.ai/inference/anthropic
ANTHROPIC_AUTH_TOKEN=oc_sk_...
ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5-5
ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-5-5
ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-5-5

GMAIL_ADDRESS=your.email@gmail.com
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx

SECRET_MASTER_KEY=<output-of-openssl-rand-base64-32>
ATS_VAULT_MASTER_SECRET=<output-of-openssl-rand-hex-32>
```

### 2. Pull & Start the Prebuilt Stack
```bash
docker compose pull && docker compose up -d
```
Access the dashboard securely via **HTTPS** (e.g., behind Caddy/Cloudflare Tunnel/Tailscale HTTPS) or an **SSH / Tailscale tunnel** (`http://localhost:8080`). Set `PUBLIC_URL`, `APP_URL`, and `CORS_ORIGINS` in `.env` to match the origin you open in your browser.

---

## How Passwords, CAPTCHAs, Email & Stealth Browsers Are Pre-Wired

| Capability | How It Works Out-of-the-Box |
| :--- | :--- |
| **Saving & Reusing Passwords** | **3-Layer Persistence**:<br>1. **`ats_get_or_create_credentials` & `ats_save_credentials` (`jobbot-mcp`)**: Encrypts passwords with `scrypt` + AES-256-GCM (`ATS_VAULT_MASTER_SECRET`) and stores them per ATS tenant (`nvidia.wd5.myworkdayjobs.com`, `icims.com`, `taleo.net`, etc.) in PostgreSQL (`ats_credentials`).<br>2. **Sync to JobPilot Web UI (`/api/credentials`)**: Once the terminal host is paired in the Web UI (writing `/root/.jobpilot/pilot.json`) or `JOBPILOT_API_TOKEN` is set in `.env`, saved logins automatically sync to `/api/credentials`.<br>3. **Browser Persistent Profile (`stealthy-auto-browse`)**: Uses Camoufox with persistent user profile in `/userdata` on an isolated Docker network (`browser-net`). |
| **reCAPTCHA & Cloudflare Turnstile** | **Layer 1**: `psyb0t/docker-stealthy-auto-browse` (Camoufox stealth Firefox + OS-level PyAutoGUI input). Passes Cloudflare Turnstile and anti-bot checks natively.<br>**Layer 2**: **Interactive Live VNC Assistance** on port `5900` (`http://<host>:5900/` or VNC client) so users can interactively view and assist with forms/CAPTCHAs/2FA.<br>**Layer 3**: `solve_captcha_challenge` MCP tool for CapSolver/2Captcha automated token fallback. |
| **Email Management (2FA & Status)** | Uses your `GMAIL_ADDRESS` + `GMAIL_APP_PASSWORD` over IMAP:<br>- `gmail_wait_for_verification_code`: Extracts 4–8 character security codes and domain-verified account activation links mid-application.<br>- `gmail_poll_application_updates`: Classifies confirmations, interviews, OAs, and rejections. |
| **GitHub Actions CI/CD** | [`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml) runs the `@job-bot/jobbot-mcp` unit test suite + `patch-origin.py --dry-run` check, and builds/pushes `postgres`, `api`, `web`, `terminal`, and `nginx` images to `ghcr.io/heretek-ai/job-bot/*:latest`. |
