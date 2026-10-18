import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import * as schema from "../drizzle/schema";

export type Database = NodePgDatabase<typeof schema>;

/**
 * Direct TCP connection to Postgres (no Hyperdrive). One short-lived client per
 * cron run is enough for a weekly job. Call `close()` when the run is done.
 *
 * TLS is always on and verified against `caCertificate` (the database's CA
 * certificate, PEM). Any `sslmode` in the URL is dropped so it cannot override
 * the `ssl` option below.
 */
export async function connect(
  databaseUrl: string,
  caCertificate: string,
): Promise<{ database: Database; close: () => Promise<void> }> {
  const url = new URL(databaseUrl);
  url.searchParams.delete("sslmode");
  const client = new Client({
    connectionString: url.toString(),
    ssl: { ca: caCertificate, rejectUnauthorized: true },
  });
  await client.connect();
  return { database: drizzle(client, { schema }), close: () => client.end() };
}
