import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

// Resolve DB url from env, with file:./data/dev.db default for local dev.
function dbUrl(): string {
  const url = process.env.DATABASE_URL ?? "file:./data/dev.db";
  // Strip Prisma's "file:" prefix; better-sqlite3 wants a plain path or ":memory:".
  return url.startsWith("file:") ? url.slice(5) : url;
}

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

function createClient(): PrismaClient {
  const adapter = new PrismaBetterSqlite3({ url: dbUrl() });
  return new PrismaClient({ adapter });
}

// Singleton across HMR reloads in dev.
export const prisma: PrismaClient = global.__prisma ?? createClient();
if (process.env.NODE_ENV !== "production") {
  global.__prisma = prisma;
}
