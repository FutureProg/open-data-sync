import { defineScheduled } from "void";
import { refreshIncidentLocations } from "../src/curated";
import { connect } from "../src/db";

// Daily: 19:00 UTC, an hour after the HRPS pipeline's daily sync at 18:00. Void requires a string literal here.
export const cron = "0 19 * * *";

export default defineScheduled(async (_controller, env) => {
  const { HYPERDRIVE } = env as unknown as { HYPERDRIVE: { connectionString: string } };
  const { database, close } = await connect(HYPERDRIVE.connectionString);
  try {
    await refreshIncidentLocations(database, (message) => console.log(message));
  } finally {
    await close();
  }
});
