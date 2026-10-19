import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import * as schema from "../drizzle/schema";

export type Database = NodePgDatabase<typeof schema>;

/**
 * Connects through Hyperdrive (`env.HYPERDRIVE.connectionString`). Workers
 * cannot verify a private CA over a direct TCP connection, so Hyperdrive holds
 * the database's CA and does the verified TLS hop; this client talks to it
 * without its own TLS. One short-lived client per cron run is enough for a
 * weekly job. Call `close()` when the run is done.
 */
export async function connect(
  connectionString: string,
): Promise<{ database: Database; close: () => Promise<void> }> {
  const client = new Client({ connectionString });
  await client.connect();
  return { database: drizzle(client, { schema }), close: () => client.end() };
}
