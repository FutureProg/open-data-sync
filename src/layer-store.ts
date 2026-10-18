import { and, count, eq, ne, sql } from "drizzle-orm";
import { arcgisRawFeatures, arcgisRawLayers } from "../db/schema";
import type { Database } from "./db";
import { isResolved, type LayerConfig } from "./layers";
import type { ArcgisFeature } from "./types";
import { DEFAULT_BATCH_SIZE, upsertFeatures } from "./upsert";

export interface StoredLayer {
  id: number;
  town: string;
  dataGroup: string;
  name: string | null;
  serviceUrl: string;
}

/**
 * Upsert the configured layers into `arcgis_raw_layers`, keyed on service_url.
 * Layers with an unresolved (`TODO`) URL are skipped. An existing row keeps its
 * `enabled` flag.
 */
export async function bootstrapLayers(
  database: Database,
  layers: readonly LayerConfig[],
): Promise<void> {
  const resolved = layers.filter(isResolved);
  if (resolved.length === 0) return;
  await database
    .insert(arcgisRawLayers)
    .values(
      resolved.map((layer) => ({
        town: layer.town,
        dataGroup: layer.dataGroup,
        name: layer.name,
        serviceUrl: layer.url,
      })),
    )
    .onConflictDoUpdate({
      target: arcgisRawLayers.serviceUrl,
      set: {
        town: sql`excluded.town`,
        dataGroup: sql`excluded.data_group`,
        name: sql`excluded.name`,
        updatedAt: sql`now()`,
      },
    });
}

export async function listEnabledLayers(database: Database): Promise<StoredLayer[]> {
  return database
    .select({
      id: arcgisRawLayers.id,
      town: arcgisRawLayers.town,
      dataGroup: arcgisRawLayers.dataGroup,
      name: arcgisRawLayers.name,
      serviceUrl: arcgisRawLayers.serviceUrl,
    })
    .from(arcgisRawLayers)
    .where(eq(arcgisRawLayers.enabled, true))
    .orderBy(arcgisRawLayers.id);
}

export async function countStoredFeatures(database: Database, layerId: number): Promise<number> {
  const [row] = await database
    .select({ total: count() })
    .from(arcgisRawFeatures)
    .where(eq(arcgisRawFeatures.layerId, layerId));
  return row?.total ?? 0;
}

/**
 * Replace a layer's stored features with a fully fetched set, in one
 * transaction: upsert, delete rows not seen in this run, stamp `last_synced_at`.
 * Call this only after the fetch fully succeeded; any failure rolls back.
 */
export async function writeLayerFeatures(
  database: Database,
  layer: StoredLayer,
  features: readonly ArcgisFeature[],
  syncedAt: Date,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<{ upserted: number; deleted: number }> {
  return database.transaction(async (transaction) => {
    const upserted = await upsertFeatures(transaction, layer, features, syncedAt, batchSize);
    // Every row seen in this run was stamped with `syncedAt`, so anything else is stale.
    const deletedRows = await transaction
      .delete(arcgisRawFeatures)
      .where(and(eq(arcgisRawFeatures.layerId, layer.id), ne(arcgisRawFeatures.syncedAt, syncedAt)))
      .returning({ id: arcgisRawFeatures.id });
    await transaction
      .update(arcgisRawLayers)
      .set({ lastSyncedAt: syncedAt, updatedAt: syncedAt })
      .where(eq(arcgisRawLayers.id, layer.id));
    return { upserted, deleted: deletedRows.length };
  });
}
