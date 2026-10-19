import { defineScheduled } from "void";
import { connect } from "../src/db";
import { syncAllLayers } from "../src/sync";

// Weekly: Tuesday 00:00 UTC. Void requires a string literal here.
export const cron = "0 0 * * 2";

export default defineScheduled(async (_controller, env) => {
  const { HYPERDRIVE } = env as unknown as { HYPERDRIVE: { connectionString: string } };
  const { database, close } = await connect(HYPERDRIVE.connectionString);
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
