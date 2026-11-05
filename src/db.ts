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
 *
 * Plain Node (e.g. `pnpm sync:once`) can connect to the database directly: pass
 * `caCertificate` (PEM) for TLS verified against it. Any `sslmode` in the URL is
 * dropped so it cannot override that. Never pass it inside the Worker, where
 * workerd ignores the CA.
 */
export async function connect(
  connectionString: string,
  caCertificate?: string,
): Promise<{ database: Database; close: () => Promise<void> }> {
  const url = new URL(connectionString);
  if (caCertificate) url.searchParams.delete("sslmode");
  const client = new Client({
    connectionString: url.toString(),
    ...(caCertificate ? { ssl: { ca: caCertificate, rejectUnauthorized: true } } : {}),
  });
  await client.connect();
  return { database: drizzle(client, { schema }), close: () => client.end() };
}
