import { queryAllFeatures, queryFeatures } from "@esri/arcgis-rest-feature-service";
import type { ArcgisFeature } from "./types";

export interface FetchedLayer {
  features: ArcgisFeature[];
  /** Features dropped because no id could be found. */
  skippedWithoutId: number;
}

interface GeoJsonFeature {
  id?: unknown;
  properties?: Record<string, unknown> | null;
  geometry?: unknown;
}

const ID_PROPERTY_NAMES = ["OBJECTID", "objectid", "FID"] as const;

function extractId(feature: GeoJsonFeature): string | undefined {
  const candidates = [feature.id, ...ID_PROPERTY_NAMES.map((name) => feature.properties?.[name])];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === "") continue;
    if (typeof candidate === "string" || typeof candidate === "number") return String(candidate);
  }
  return undefined;
}

/**
 * Fetch every feature of an ArcGIS layer as GeoJSON in WGS84 (4326).
 *
 * Requests, paging (page size from the layer's `maxRecordCount`, and an
 * `exceededTransferLimit` flag found at the top level or in `properties`) and
 * error handling (HTTP errors and HTTP 200 `{ error }` bodies) come from the Esri
 * `queryAllFeatures` helper. The Esri client always uses the global `fetch`.
 *
 * The helper stops when the flag is missing, so a server that never sets it
 * would be truncated silently. To rule that out, the number of features
 * received is checked against the layer's own count, and a shortfall throws.
 */
export async function fetchLayerFeatures(layerUrl: string): Promise<FetchedLayer> {
  const response = await queryAllFeatures({ url: layerUrl, f: "geojson", outSR: "4326" });
  const received = response.features as unknown as GeoJsonFeature[];

  const { count } = (await queryFeatures({
    url: layerUrl,
    returnCountOnly: true,
  })) as { count?: number };
  if (typeof count === "number" && received.length < count) {
    throw new Error(
      `${layerUrl} reports ${count} features but only ${received.length} were returned`,
    );
  }

  const featuresById = new Map<string, ArcgisFeature>();
  let skippedWithoutId = 0;
  for (const feature of received) {
    const sourceFeatureId = extractId(feature);
    if (sourceFeatureId === undefined) {
      skippedWithoutId += 1;
      continue;
    }
    featuresById.set(sourceFeatureId, {
      sourceFeatureId,
      attributes: feature.properties ?? {},
      geometry: feature.geometry ?? null,
    });
  }
  return { features: [...featuresById.values()], skippedWithoutId };
}
