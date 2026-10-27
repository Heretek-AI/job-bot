# Builds JobPilot API from a pinned upstream commit so API and Web stay 100% synchronized.
FROM oven/bun:1-alpine AS deps
WORKDIR /app

RUN apk add --no-cache git ca-certificates openssl

ARG JOBPILOT_COMMIT=08fa978ecac0da68b0ee5694c93c0d94f18b4d9f
RUN git clone https://github.com/suxrobGM/jobpilot.git /app \
    && git checkout "${JOBPILOT_COMMIT}"

RUN bun install --frozen-lockfile --filter @jobpilot/api

WORKDIR /app/apps/api
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" bun run db:generate

FROM oven/bun:1-alpine AS runner
WORKDIR /app/apps/api

RUN apk add --no-cache openssl postgresql16-client

COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/package.json /app/package.json
COPY --from=deps /app/packages/contracts /app/packages/contracts
COPY --from=deps /app/apps/api /app/apps/api

RUN mkdir -p storage /app/shared/resumes

ENV NODE_ENV=production
ENV PORT=4101
EXPOSE 4101

CMD ["bun", "run", "start"]
