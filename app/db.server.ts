import { PrismaClient } from "@prisma/client";

// The Prisma datasource reads `env("DATABASE_URL")` (so production can swap to Postgres/MySQL
// by setting that one variable — see DECISIONS.md §2). The Prisma CLI loads `.env`, but the
// generated client reads `process.env` directly at runtime and does not. This default keeps
// `shopify app dev` working with the scaffold's local SQLite file when DATABASE_URL is unset,
// using the exact same relative path string the scaffold hardcoded.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "file:dev.sqlite";
}

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient();
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient();

export default prisma;
