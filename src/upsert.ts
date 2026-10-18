import { sql } from "drizzle-orm";
import { arcgisRawFeatures } from "../db/schema";
import type { Database } from "./db";
import type { ArcgisFeature } from "./types";

/** Five bound parameters per row, so this stays far below Postgres' 65535 limit. */
export const DEFAULT_BATCH_SIZE = 500;

/** Anything that can run an insert: the database itself or a transaction on it. */
export type InsertExecutor = Pick<Database, "insert">;

/** `excluded.<column>` when it differs from the stored value (null-safe), else the stored value. */
function keepUnlessChanged(column: string) {
  const stored = sql.raw(`arcgis_raw_features.${column}`);
  const incoming = sql.raw(`excluded.${column}`);
  return sql`CASE WHEN ${stored} IS DISTINCT FROM ${incoming} THEN ${incoming} ELSE ${stored} END`;
}

export function chunk<Item>(items: readonly Item[], size: number): Item[][] {
  const chunks: Item[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

/**
 * Upsert features into `open_data_sync.arcgis_raw_features`, conflicting on
 * (layer_id, source_feature_id), converting GeoJSON geometry to PostGIS (SRID
 * 4326), and stamping `synced_at`. Returns the number of rows written.
 */
export async function upsertFeatures(
  executor: InsertExecutor,
  layer: { id: number; dataGroup: string },
  features: readonly ArcgisFeature[],
  syncedAt: Date,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<number> {
  let written = 0;
  for (const batch of chunk(features, batchSize)) {
    await executor
      .insert(arcgisRawFeatures)
      .values(
        batch.map((feature) => ({
          layerId: layer.id,
          dataGroup: layer.dataGroup,
          sourceFeatureId: feature.sourceFeatureId,
          attributes: feature.attributes,
          geometry: feature.geometry
            ? sql<string>`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(feature.geometry)}), 4326)`
            : null,
          syncedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [arcgisRawFeatures.layerId, arcgisRawFeatures.sourceFeatureId],
        // `synced_at` always moves (stale detection depends on it); the other
        // columns are only replaced when the incoming value differs.
        set: {
          dataGroup: keepUnlessChanged("data_group"),
          attributes: keepUnlessChanged("attributes"),
          geometry: keepUnlessChanged("geometry"),
          syncedAt: sql`excluded.synced_at`,
        },
      });
    written += batch.length;
  }
  return written;
}
