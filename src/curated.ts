import { sql } from "drizzle-orm";
import type { Database } from "./db";
import type { LayerSyncResult } from "./sync";

type Log = (message: string) => void;

/**
 * The curated views only need rebuilding when a layer was actually downloaded. A failed
 * layer makes `syncAllLayers` throw before this is reached, so the views never see a
 * half-synced run.
 */
export function shouldRefreshCurated(results: readonly LayerSyncResult[]): boolean {
  return results.some((result) => !result.unchanged && !result.error);
}

/** Log the one-row data quality view (`incidents.integration_qa`). */
export async function logIntegrationQa(database: Database, log: Log): Promise<void> {
  const { rows } = await database.execute(sql`SELECT * FROM incidents.integration_qa`);
  log(`integration_qa: ${JSON.stringify(rows[0])}`);
}

/**
 * Rebuild the geo views (wards, road segments, intersections), then recompute every
 * incident's location against them. Two calls so that geo never depends on incidents.
 */
export async function refreshCurated(database: Database, log: Log): Promise<void> {
  await database.execute(sql`SELECT geo.refresh_curated()`);
  log("geo.refresh_curated: rebuilt wards, road segments and intersections");
  const { rows } = await database.execute<{ written: number }>(
    sql`SELECT incidents.refresh_incident_locations(true) AS written`,
  );
  log(
    `incidents.refresh_incident_locations: recomputed ${rows[0]?.written ?? 0} incident locations`,
  );
  await logIntegrationQa(database, log);
}

/** Locate incidents that are new or changed since their location was computed. */
export async function refreshIncidentLocations(database: Database, log: Log): Promise<void> {
  const { rows } = await database.execute<{ written: number }>(
    sql`SELECT incidents.refresh_incident_locations() AS written`,
  );
  log(`incidents.refresh_incident_locations: wrote ${rows[0]?.written ?? 0} incident locations`);
  await logIntegrationQa(database, log);
}
