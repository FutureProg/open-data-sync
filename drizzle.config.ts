import { defineConfig } from "drizzle-kit";

// drizzle-kit ignores `ssl` when given a plain `url`, so the connection URL is
// expanded into discrete fields whenever a CA is supplied.
const dbUrl = new URL(process.env.DATABASE_URL ?? "postgresql://invalid");

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./db/migrations",
  // Only ever look at our own schema; the database is shared with other apps.
  schemaFilter: ["open_data_sync"],
  // Keep drizzle's bookkeeping table inside open_data_sync too.
  migrations: { schema: "open_data_sync", table: "__drizzle_migrations" },
  dbCredentials: process.env.DB_CA_CERT
    ? {
        host: dbUrl.hostname,
        port: Number(dbUrl.port) || 5432,
        user: decodeURIComponent(dbUrl.username),
        password: decodeURIComponent(dbUrl.password),
        database: dbUrl.pathname.slice(1),
        ssl: { ca: process.env.DB_CA_CERT, rejectUnauthorized: true },
      }
    : { url: process.env.DATABASE_URL ?? "", ssl: false },
});
