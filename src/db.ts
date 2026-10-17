import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import * as schema from "../db/schema";

export type Db = NodePgDatabase<typeof schema>;

/**
 * Direct TCP connection to Postgres (no Hyperdrive). One short-lived client per
 * cron run is enough for a weekly job. Call `close()` when the run is done.
 */
export async function connect(
  databaseUrl: string,
): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  return { db: drizzle(client, { schema }), close: () => client.end() };
}
