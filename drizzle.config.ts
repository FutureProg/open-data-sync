import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./db/migrations",
  // Only ever look at our own schema; the database is shared with other apps.
  schemaFilter: ["open_data_sync"],
  // Keep drizzle's bookkeeping table inside open_data_sync too.
  migrations: { schema: "open_data_sync", table: "__drizzle_migrations" },
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
