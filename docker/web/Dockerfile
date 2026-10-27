# Builds a prepackaged, origin-agnostic suxrobGM/jobpilot Web UI image.
# Browser requests dynamically use window.location.origin (/api and /terminal) via Nginx,
# so one prebuilt GHCR image works on ANY remote IP, Tailscale hostname, or domain!
FROM oven/bun:1-slim AS build
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/suxrobGM/jobpilot.git /app

COPY patch-origin.py /tmp/patch-origin.py
RUN python3 /tmp/patch-origin.py

RUN bun install --frozen-lockfile --ignore-scripts

WORKDIR /app/apps/api
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" bun run db:generate

WORKDIR /app/apps/web
RUN bun run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public

ENV PORT=4100
ENV HOSTNAME=0.0.0.0
ENV INTERNAL_API_URL=http://api:4101
EXPOSE 4100

CMD ["node", "apps/web/server.js"]
