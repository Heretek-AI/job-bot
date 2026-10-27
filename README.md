# Job-Bot: Prepackaged Autonomous Job Application Stack

Everything comes **prebuilt and prewired** via GitHub Actions CI (`ghcr.io/heretek-ai/job-bot/*`). To run on any remote Docker server, the **only** thing you need to do is fill out `.env` and start the stack.

---

## 2-Step Remote Deployment

### 1. Create `.env`
Download `docker-compose.yml` and `.env.example` (or clone the repo) on your remote Docker machine:
```bash
cp .env.example .env
```
Fill in your **OpenCode** key/models and **Gmail App Password** in `.env`:
```dotenv
ANTHROPIC_BASE_URL=https://opencode.ai/inference/anthropic
ANTHROPIC_AUTH_TOKEN=oc_sk_...
ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5-5
ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-5-5
ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-5-5

GMAIL_ADDRESS=your.email@gmail.com
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
```

### 2. Pull & Start the Prebuilt Stack
```bash
docker compose pull && docker compose up -d
```
Then open `http://<YOUR_REMOTE_SERVER_IP>:8080` in your browser!
- **Origin-Agnostic Web & Reverse Proxy**: The prebuilt `web` and `nginx` containers automatically resolve `window.location.origin` (`/api` and `/terminal/ws`), so the stack works on any IP address, Tailscale hostname, or custom domain without rebuilding images or editing CORS configs.

---

## How Passwords, CAPTCHAs, Email & Stealth Browsers Are Pre-Wired

| Capability | How It Works Out-of-the-Box |
| :--- | :--- |
| **Saving & Reusing Passwords** | **3-Layer Persistence**:<br>1. **`ats_get_or_create_credentials` & `ats_save_credentials` (`jobbot-mcp`)**: Encrypts passwords with AES-256-GCM (`ATS_VAULT_MASTER_SECRET`) and stores them per ATS tenant (`nvidia.wd5.myworkdayjobs.com`, `icims.com`, `taleo.net`, etc.) in PostgreSQL (`ats_credentials`).<br>2. **Auto-Sync to JobPilot Web UI**: Automatically syncs saved logins to `/api/credentials` so you can view/manage them in the dashboard.<br>3. **Browser Password Store (`CloakBrowser`)**: Runs with `--user-data-dir=/data/profile` and `--password-store=basic` on a persistent Docker volume. |
| **reCAPTCHA & Cloudflare Turnstile** | **Layer 1**: `CloakHQ/CloakBrowser` (C++-source-patched Chromium over CDP `:9222`) + optional `invisible_playwright_mcp` (C++-patched Firefox). Passes Cloudflare Turnstile and reCAPTCHA v3 natively.<br>**Layer 2**: `solve_captcha_challenge` MCP tool for CapSolver/2Captcha fallback. |
| **Email Management (2FA & Status)** | Uses your `GMAIL_ADDRESS` + `GMAIL_APP_PASSWORD` over IMAP:<br>- `gmail_wait_for_verification_code`: Extracts 4–8 digit security codes and domain-verified account activation links mid-application.<br>- `gmail_poll_application_updates`: Classifies confirmations, interviews, OAs, and rejections. |
| **GitHub Actions CI/CD** | [`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml) runs the `@job-bot/jobbot-mcp` unit test suite and builds/pushes `postgres`, `nginx`, `cloakbrowser`, `web`, and `terminal` images to `ghcr.io/heretek-ai/job-bot/*:latest`. |
