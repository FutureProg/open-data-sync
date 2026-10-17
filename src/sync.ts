import type { SyncEnv } from "./types";

/**
 * Sync every enabled, resolved layer: fetch its features from ArcGIS, upsert
 * them, and update `arcgis_raw_layers.last_synced_at`. One failing layer should
 * not stop the others.
 *
 * TODO: implement. Not implemented in the scaffold.
 */
export async function syncAllLayers(_env: SyncEnv): Promise<void> {
  throw new Error("Not implemented");
}
