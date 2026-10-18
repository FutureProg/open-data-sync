import { execFileSync } from "node:child_process";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../db/schema";
import type { Database } from "../../src/db";

export function isDockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

export interface TestDatabase {
  database: Database;
  /** Empty both tables between tests. */
  reset: () => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Start a throwaway PostGIS container and apply the repo's real migrations.
 * The schema and the extension are created here only; migrations never do that.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer("postgis/postgis:16-3.4").start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  await pool.query("CREATE EXTENSION IF NOT EXISTS postgis");
  await pool.query("CREATE SCHEMA IF NOT EXISTS open_data_sync");
  const database = drizzle(pool, { schema });
  await migrate(database, {
    migrationsFolder: "db/migrations",
    migrationsSchema: "open_data_sync",
    migrationsTable: "__drizzle_migrations",
  });
  return {
    database,
    reset: async () => {
      await pool.query("TRUNCATE open_data_sync.arcgis_raw_layers RESTART IDENTITY CASCADE");
    },
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}
