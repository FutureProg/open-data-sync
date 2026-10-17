import type { LayerConfig } from "./layers";
import type { ArcgisFeature } from "./types";

export type { Db } from "./db";
import type { Db } from "./db";

/**
 * Upsert features into `open_data_sync.arcgis_raw_features`, conflicting on
 * (layer_id, source_feature_id), converting geometry to PostGIS (SRID 4326), and
 * stamping `synced_at`. Returns the number of rows written.
 *
 * TODO: implement. Not implemented in the scaffold.
 */
export async function upsertFeatures(
  _db: Db,
  _layer: LayerConfig,
  _features: ArcgisFeature[],
): Promise<number> {
  throw new Error("Not implemented");
}
