#!/bin/sh
set -e

# Ensure schema is applied on the persistent SQLite DB before booting the app.
# `prisma db push --accept-data-loss` is idempotent and matches `db push` semantics.
if [ -n "$DATABASE_URL" ]; then
  node ./node_modules/prisma/build/index.js db push --accept-data-loss
  # Seed only if the singleton row is missing.
  node ./node_modules/tsx/dist/cli.mjs prisma/seed.ts || true
fi

exec "$@"
