import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../drizzle/schema";

export type Database = PostgresJsDatabase<typeof schema>;

/**
 * Connects through Hyperdrive (`env.HYPERDRIVE.connectionString`). Workers
 * cannot verify a private CA over a direct TCP connection, so Hyperdrive holds
 * the database's CA and does the verified TLS hop; this client talks to it
 * without its own TLS. One short-lived client per cron run is enough. Call `close()` when the run is done.
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
  // `prepare: false`: Hyperdrive pools in transaction mode, where named prepared statements do not survive.
  const client = postgres(url.toString(), {
    max: 1,
    prepare: false,
    ...(caCertificate ? { ssl: { ca: caCertificate, rejectUnauthorized: true } } : {}),
  });
  return { database: drizzle(client, { schema }), close: () => client.end() };
}
