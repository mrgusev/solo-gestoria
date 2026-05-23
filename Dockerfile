# syntax=docker/dockerfile:1.7

# ---- Stage 1: install deps (cached) ----
FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# Keeps devDeps too — the `tools` runtime stage needs `tsx` to run scripts.
RUN npm ci

# ---- Stage 2: build ----
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

# ---- Stage 3a: web runtime (standalone bundle, ~150 MB) ----
# This is the default target. `node server.js` serves the Next.js app.
FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3010 \
    HOSTNAME=0.0.0.0 \
    DATABASE_URL=file:/data/dev.db \
    UPLOAD_DIR=/uploads
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs nextjs \
    && mkdir -p /data /uploads /app \
    && chown -R nextjs:nodejs /data /uploads /app
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=build --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts
COPY --from=build --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=nextjs:nodejs /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --chown=nextjs:nodejs docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER nextjs
EXPOSE 3010
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]

# ---- Stage 3b: tools runtime (~400 MB, includes scripts + tsx) ----
# Used by the `bot` and `migrate` compose services. Has the full node_modules
# (so `tsx` works) plus src/ and scripts/ so .ts files can be executed
# directly without a separate build step.
FROM node:24-bookworm-slim AS tools
WORKDIR /app
ENV NODE_ENV=production \
    DATABASE_URL=file:/data/dev.db \
    UPLOAD_DIR=/uploads
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs nextjs \
    && mkdir -p /data /uploads /app \
    && chown -R nextjs:nodejs /data /uploads /app
# Full node_modules (so tsx, openai, jose, zod, etc. are all available).
COPY --from=build --chown=nextjs:nodejs /app/node_modules ./node_modules
# Source code that scripts/ imports from.
COPY --from=build --chown=nextjs:nodejs /app/src ./src
COPY --from=build --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=build --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=build --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts
COPY --from=build --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=build --chown=nextjs:nodejs /app/package-lock.json ./package-lock.json

USER nextjs
# No ENTRYPOINT — the compose service supplies the command directly
# (`npx tsx scripts/bot-poll.ts` or `npx tsx scripts/migrate-historical.ts`).
CMD ["node", "--version"]
