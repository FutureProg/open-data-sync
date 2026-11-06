// Single source of truth for the cron schedules. `cloudflare.config.ts` registers them and
// `worker.ts` dispatches on them, so the two cannot drift apart.

/** Weekly, Tuesday 00:00 UTC: sync the ArcGIS layers, then rebuild the curated geography. */
export const SYNC_ARCGIS_LAYERS = "0 0 * * 2";

/** Daily, 19:00 UTC, an hour after the HRPS pipeline's 18:00 sync: locate new incidents. */
export const REFRESH_INCIDENT_LOCATIONS = "0 19 * * *";
