# Builds a prepackaged, origin-agnostic suxrobGM/jobpilot Web UI image from a pinned commit.
# Browser requests dynamically use window.location.origin (/api and /terminal) via Nginx,
# so one prebuilt GHCR image works on ANY remote IP, Tailscale hostname, or domain!
FROM oven/bun:1-slim AS build
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 && rm -rf /var/lib/apt/lists/*

ARG JOBPILOT_COMMIT=08fa978ecac0da68b0ee5694c93c0d94f18b4d9f
RUN git clone https://github.com/suxrobGM/jobpilot.git /app \
    && git checkout "${JOBPILOT_COMMIT}"

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
