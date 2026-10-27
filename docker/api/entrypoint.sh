#!/bin/sh
set -e

# 1. Strip empty-string optional env vars so Zod .optional() in src/env.ts sees undefined instead of ""
for var in SUPER_ADMIN_EMAIL GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET RESEND_API_KEY VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY VAPID_SUBJECT; do
  eval "val=\${$var:-}"
  if [ -z "$val" ]; then
    unset "$var"
  fi
done

# 2. Ensure SECRET_MASTER_KEY is a valid 32-byte base64 key (auto-generate & persist if left at placeholder)
KEY_LEN=0
case "${SECRET_MASTER_KEY:-}" in
  ""|REPLACE_*) KEY_LEN=0 ;;
  *) KEY_LEN=$(printf "%s" "$SECRET_MASTER_KEY" | openssl base64 -d -A 2>/dev/null | wc -c | tr -d ' ') ;;
esac

if [ "$KEY_LEN" != "32" ]; then
  mkdir -p /app/apps/api/storage
  if [ ! -s /app/apps/api/storage/.secret_master_key ]; then
    openssl rand -base64 32 | tr -d '\r\n' > /app/apps/api/storage/.secret_master_key
  fi
  export SECRET_MASTER_KEY=$(cat /app/apps/api/storage/.secret_master_key | tr -d '\r\n')
  echo "[api-entrypoint] Auto-loaded persistent 32-byte SECRET_MASTER_KEY from storage"
fi

# 3. Database migration mode: if _prisma_migrations does not exist yet, ensure public schema
#    has no pre-existing vault tables before running Prisma 7's db:migrate:apply (avoids P3005).
case "$*" in
  *"--skip-generate"*|*"db push"*|*"db:migrate:apply"*)
    echo "[api-entrypoint] Preparing schema & running Prisma 7 database migrations (bun run db:migrate:apply)..."
    HAS_MIGRATIONS=$(psql "$DATABASE_URL" -tAc "SELECT to_regclass('public._prisma_migrations');" 2>/dev/null | tr -d ' \r\n' || true)
    if [ -z "$HAS_MIGRATIONS" ]; then
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP TABLE IF EXISTS public.ats_credentials, public.imap_processed_emails CASCADE;"
    fi
    exec bun run db:migrate:apply
    ;;
esac

# 4. If starting the API server, run idempotent db:seed (job-board catalog + super-admin) first
if [ "$1" = "bun" ] && [ "$2" = "run" ] && [ "$3" = "start" ]; then
  echo "[api-entrypoint] Seeding job-board catalog (bun run db:seed)..."
  bun run db:seed || echo "[api-entrypoint] Warning: db:seed returned non-zero, continuing..."
fi

exec "$@"
