import { refreshCurated, refreshIncidentLocations, shouldRefreshCurated } from "./curated";
import { connect } from "./db";
import { syncAllLayers } from "./sync";

export type HyperdriveEnv = { HYPERDRIVE: { connectionString: string } };

const log = (message: string) => console.log(message);

/** Weekly: download changed ArcGIS layers, then rebuild `geo` and recompute incident locations. */
export async function syncArcgisLayers(env: HyperdriveEnv): Promise<void> {
  const { database, close } = await connect(env.HYPERDRIVE.connectionString);
  try {
    const results = await syncAllLayers({ database, now: () => new Date(), log });
    if (shouldRefreshCurated(results)) await refreshCurated(database, log);
    else log("refresh_curated: every layer was unchanged, nothing to rebuild");
  } finally {
    await close();
  }
}

/** Daily: locate new or changed HRPS incidents and refresh `incidents.incidents`. */
export async function refreshIncidentLocationsJob(env: HyperdriveEnv): Promise<void> {
  const { database, close } = await connect(env.HYPERDRIVE.connectionString);
  try {
    await refreshIncidentLocations(database, log);
  } finally {
    await close();
  }
}
