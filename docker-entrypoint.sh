#!/bin/sh
set -e

# Ensure schema is applied on the persistent SQLite DB before booting the app.
# `prisma db push --accept-data-loss` is idempotent and matches `db push` semantics.
if [ -n "$DATABASE_URL" ]; then
  npx --no-install prisma db push --skip-generate --accept-data-loss
  # Seed only if the singleton row is missing.
  npx --no-install tsx prisma/seed.ts || true
fi

exec "$@"
