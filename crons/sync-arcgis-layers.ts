import { defineScheduled } from "void";
import { env } from "void/env";
import { connect } from "../src/db";
import { syncAllLayers } from "../src/sync";

// Weekly: Monday 06:00 UTC. Void requires a string literal here.
export const cron = "0 6 * * 1";

export default defineScheduled(async () => {
  const { database, close } = await connect(env.DATABASE_URL, env.DB_CA_CERT);
  try {
    await syncAllLayers({
      database,
      now: () => new Date(),
      log: (message) => console.log(message),
    });
  } finally {
    await close();
  }
});
