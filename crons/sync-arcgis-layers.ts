import { defineScheduled } from "void";
import { connect } from "../src/db";
import { syncAllLayers } from "../src/sync";

// Weekly: Monday 06:00 UTC. Void requires a string literal here.
export const cron = "0 6 * * 1";

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
