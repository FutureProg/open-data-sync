import { and, count, eq, ne, sql } from "drizzle-orm";
import { arcgisRawFeatures, arcgisRawLayers } from "../drizzle/schema";
import type { Database } from "./db";
import type { SourceFingerprint } from "./fingerprint";
import { isResolved, type LayerConfig } from "./layers";
import type { ArcgisFeature } from "./types";
import { DEFAULT_BATCH_SIZE, upsertFeatures } from "./upsert";

export interface StoredLayer {
  id: number;
  town: string;
  dataGroup: string;
  name: string | null;
  serviceUrl: string;
  lastSyncedAt: Date | null;
  /** Fingerprint saved by the last successful full sync, if any. */
  fingerprint: SourceFingerprint | null;
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
      // Leave unchanged rows alone (`enabled` is never written here).
      setWhere: sql`(arcgis_raw_layers.town, arcgis_raw_layers.data_group, arcgis_raw_layers.name)
        IS DISTINCT FROM (excluded.town, excluded.data_group, excluded.name)`,
    });
}

export async function listEnabledLayers(database: Database): Promise<StoredLayer[]> {
  const rows = await database
    .select({
      id: arcgisRawLayers.id,
      town: arcgisRawLayers.town,
      dataGroup: arcgisRawLayers.dataGroup,
      name: arcgisRawLayers.name,
      serviceUrl: arcgisRawLayers.serviceUrl,
      lastSyncedAt: arcgisRawLayers.lastSyncedAt,
      sourceFeatureCount: arcgisRawLayers.sourceFeatureCount,
      sourceLastEditedAt: arcgisRawLayers.sourceLastEditedAt,
    })
    .from(arcgisRawLayers)
    .where(eq(arcgisRawLayers.enabled, true))
    .orderBy(arcgisRawLayers.id);
  return rows.map(({ sourceFeatureCount, sourceLastEditedAt, ...layer }) => ({
    ...layer,
    fingerprint:
      sourceFeatureCount === null
        ? null
        : { featureCount: sourceFeatureCount, lastEditedAt: sourceLastEditedAt },
  }));
}

/** Record that the source was checked and found unchanged; no feature row is touched. */
export async function markLayerUnchanged(
  database: Database,
  layer: StoredLayer,
  syncedAt: Date,
): Promise<void> {
  await database
    .update(arcgisRawLayers)
    .set({ lastSyncedAt: syncedAt, updatedAt: syncedAt })
    .where(eq(arcgisRawLayers.id, layer.id));
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
 * transaction: upsert, delete rows not seen in this run, stamp `last_synced_at`
 * and save the source fingerprint (null clears it when it is unknown).
 * Call this only after the fetch fully succeeded; any failure rolls back.
 */
export async function writeLayerFeatures(
  database: Database,
  layer: StoredLayer,
  features: readonly ArcgisFeature[],
  syncedAt: Date,
  batchSize: number = DEFAULT_BATCH_SIZE,
  fingerprint: SourceFingerprint | null = null,
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
      .set({
        lastSyncedAt: syncedAt,
        updatedAt: syncedAt,
        sourceFeatureCount: fingerprint?.featureCount ?? null,
        sourceLastEditedAt: fingerprint?.lastEditedAt ?? null,
      })
      .where(eq(arcgisRawLayers.id, layer.id));
    return { upserted, deleted: deletedRows.length };
  });
}
