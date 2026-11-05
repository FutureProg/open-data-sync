import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/worker.ts" with { type: "cf-worker" };
import { REFRESH_INCIDENT_LOCATIONS, SYNC_ARCGIS_LAYERS } from "./src/schedules.ts";

// Hyperdrive config for the existing Postgres. It holds the database's CA (Workers cannot
// verify a private CA on a direct connection). The ID comes from the environment so no
// account-specific value is committed to this public repo: set HYPERDRIVE_ID in the shell
// or CI that runs `cf deploy`.
//
// Without it the placeholder below keeps `vp check`, tests and `cf build` working, because
// they load this file. It is not a valid ID, so a deploy with it fails instead of binding
// the wrong database.
const hyperdriveId = process.env.HYPERDRIVE_ID ?? "HYPERDRIVE_ID-not-set";

export default defineConfig({
  worker: {
    name: "open-data-sync",
    entrypoint,
    compatibilityDate: "2026-02-24",
    compatibilityFlags: ["nodejs_compat"],
    triggers: [
      triggers.scheduled({ schedule: SYNC_ARCGIS_LAYERS }),
      triggers.scheduled({ schedule: REFRESH_INCIDENT_LOCATIONS }),
    ],
    // Workers Logs and real-time Issues. Cloudflare turns them off for any version
    // deployed without them, so they have to be declared here.
    observability: {
      logs: { enabled: true, invocationLogs: true, persist: true },
      issues: { enabled: true },
    },
    env: {
      HYPERDRIVE: bindings.hyperdrive({ id: hyperdriveId }),
    },
  },
});
