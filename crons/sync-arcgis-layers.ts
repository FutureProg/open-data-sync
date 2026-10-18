import { defineScheduled } from "void";
import { syncAllLayers } from "../src/sync";

// Weekly: Monday 06:00 UTC. Void requires a string literal here.
export const cron = "0 6 * * 1";

export default defineScheduled(async (_controller, env) => {
  await syncAllLayers(env);
});
