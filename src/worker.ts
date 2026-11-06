import { refreshIncidentLocationsJob, syncArcgisLayers, type HyperdriveEnv } from "./jobs";
import { REFRESH_INCIDENT_LOCATIONS, SYNC_ARCGIS_LAYERS } from "./schedules";

// Cron-only Worker: there is no fetch handler. Each cron schedule in `cloudflare.config.ts`
// reaches `scheduled()` with `controller.cron` set to that schedule's string. Jobs are awaited so a
// failure fails the invocation and shows up in Issues.
export default {
  async scheduled(controller, env) {
    switch (controller.cron) {
      case SYNC_ARCGIS_LAYERS:
        await syncArcgisLayers(env);
        return;
      case REFRESH_INCIDENT_LOCATIONS:
        await refreshIncidentLocationsJob(env);
        return;
      default:
        // Fail loudly so Issues records it, rather than a schedule silently doing nothing.
        throw new Error(`No job is registered for cron "${controller.cron}"`);
    }
  },
} satisfies ExportedHandler<HyperdriveEnv>;
