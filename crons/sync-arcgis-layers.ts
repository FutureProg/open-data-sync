import { defineScheduled } from "void";
import { refreshCurated, shouldRefreshCurated } from "../src/curated";
import { connect } from "../src/db";
import { syncAllLayers } from "../src/sync";

// Weekly: Tuesday 00:00 UTC. Void requires a string literal here.
export const cron = "0 0 * * 2";

export default defineScheduled(async (_controller, env) => {
  const { HYPERDRIVE } = env as unknown as { HYPERDRIVE: { connectionString: string } };
  const { database, close } = await connect(HYPERDRIVE.connectionString);
  try {
    const log = (message: string) => console.log(message);
    const results = await syncAllLayers({ database, now: () => new Date(), log });
    if (shouldRefreshCurated(results)) await refreshCurated(database, log);
    else log("refresh_curated: every layer was unchanged, nothing to rebuild");
  } finally {
    await close();
  }
});
