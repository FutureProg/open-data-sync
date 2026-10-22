import { execFileSync } from "node:child_process";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../drizzle/schema";
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
  /** Raw SQL against the test database. */
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  /** Empty the raw tables, the incident locations and the HRPS stand-in between tests. */
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
  // Stand-in for the HRPS pipeline's table, which this repo reads but never creates.
  await pool.query("CREATE SCHEMA IF NOT EXISTS safe_streets_halton");
  await pool.query(`CREATE TABLE IF NOT EXISTS safe_streets_halton.hrps_data (
    case_no text,
    date timestamptz NOT NULL,
    description text NOT NULL,
    location text,
    city text,
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    "globalId" varchar(255) NOT NULL UNIQUE,
    inserted_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  const database = drizzle(pool, { schema });
  await migrate(database, {
    migrationsFolder: "drizzle/migrations",
    migrationsSchema: "open_data_sync",
    migrationsTable: "__drizzle_migrations",
  });
  return {
    database,
    query: (text, values) => pool.query(text, values),
    reset: async () => {
      await pool.query("TRUNCATE open_data_sync.arcgis_raw_layers RESTART IDENTITY CASCADE");
      await pool.query("TRUNCATE open_data_sync.incident_locations");
      await pool.query("TRUNCATE safe_streets_halton.hrps_data");
    },
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}
