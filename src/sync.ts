import type { Database } from "./db";
import { fetchLayerFeatures } from "./fetch-layer";
import { LAYERS, type LayerConfig } from "./layers";
import {
  bootstrapLayers,
  countStoredFeatures,
  listEnabledLayers,
  writeLayerFeatures,
  type StoredLayer,
} from "./layer-store";

export interface SyncDependencies {
  database: Database;
  now: () => Date;
  log: (message: string) => void;
}

export interface LayerSyncResult {
  serviceUrl: string;
  fetched: number;
  upserted: number;
  skipped: number;
  deleted: number;
  error?: string;
}

async function syncLayer(
  dependencies: SyncDependencies,
  layer: StoredLayer,
): Promise<LayerSyncResult> {
  const result: LayerSyncResult = {
    serviceUrl: layer.serviceUrl,
    fetched: 0,
    upserted: 0,
    skipped: 0,
    deleted: 0,
  };
  try {
    const { features, skippedWithoutId } = await fetchLayerFeatures(layer.serviceUrl);
    result.fetched = features.length + skippedWithoutId;
    result.skipped = skippedWithoutId;
    if (features.length === 0) {
      // An empty answer for a populated layer is more likely an outage than a real
      // deletion of everything, so keep the rows and fail the layer.
      const existing = await countStoredFeatures(dependencies.database, layer.id);
      if (existing > 0) {
        throw new Error(
          `${layer.name ?? layer.serviceUrl} returned 0 features but ${existing} rows exist; nothing was changed`,
        );
      }
    }
    const written = await writeLayerFeatures(
      dependencies.database,
      layer,
      features,
      dependencies.now(),
    );
    result.upserted = written.upserted;
    result.deleted = written.deleted;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

/**
 * Sync every enabled, resolved layer: fetch its features from ArcGIS, upsert
 * them, delete stale ones and set `last_synced_at`. One failing layer does not
 * stop the others; after all layers a summary is logged and, if any layer
 * failed, an error is thrown so the cron run is marked failed.
 */
export async function syncAllLayers(
  dependencies: SyncDependencies,
  configuredLayers: readonly LayerConfig[] = LAYERS,
): Promise<LayerSyncResult[]> {
  await bootstrapLayers(dependencies.database, configuredLayers);
  const layers = await listEnabledLayers(dependencies.database);

  const results: LayerSyncResult[] = [];
  for (const layer of layers) {
    results.push(await syncLayer(dependencies, layer));
  }

  for (const result of results) {
    dependencies.log(
      `${result.serviceUrl}: fetched=${result.fetched} upserted=${result.upserted} ` +
        `skipped=${result.skipped} deleted=${result.deleted}` +
        (result.error ? ` error=${result.error}` : ""),
    );
  }
  const failed = results.filter((result) => result.error);
  if (failed.length > 0) {
    throw new Error(
      `${failed.length} of ${results.length} layers failed to sync: ` +
        failed.map((result) => result.serviceUrl).join(", "),
    );
  }
  return results;
}
