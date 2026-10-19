// One-off run of the weekly sync from your machine, e.g. after a missed cron:
//   pnpm sync:once
// Runs in plain Node, so it can verify the database's private CA directly
// (workerd cannot, which is why the deployed Worker goes through Hyperdrive).
// Reads DATABASE_URL and DB_CA_CERT from .env; leave DB_CA_CERT empty for a local,
// non-TLS Postgres. This writes to whatever DATABASE_URL points at.
import { connect } from "../src/db";
import { syncAllLayers } from "../src/sync";

const { DATABASE_URL, DB_CA_CERT } = process.env;
if (!DATABASE_URL) throw new Error("DATABASE_URL is not set (see example.env).");

const target = new URL(DATABASE_URL);
console.log(`Syncing into ${target.hostname}:${target.port}${target.pathname}`);

const { database, close } = await connect(DATABASE_URL, DB_CA_CERT || undefined);
try {
  await syncAllLayers({
    database,
    now: () => new Date(),
    log: (message) => console.log(message),
  });
} finally {
  await close();
}
