import { PrismaClient } from "@prisma/client";

// The Prisma datasource reads `env("DATABASE_URL")`. PostgreSQL is the only supported engine —
// the migration history is Postgres-dialect SQL (see DECISIONS.md §2).
//
// There is deliberately NO fallback default here. A missing DATABASE_URL previously fell back to
// a local SQLite file, which inside a container meant the app booted against throwaway storage
// and discarded every merchant's data on redeploy. Failing at boot is the safe behavior.
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. Easy CRM requires a PostgreSQL connection string, e.g. " +
      "postgresql://user:pass@host:5432/easycrm?schema=public",
  );
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
