import type { ArcgisFeature } from "./types";

/** Used when the layer's `maxRecordCount` cannot be read. */
const DEFAULT_PAGE_SIZE = 1000;

export interface FetchedLayer {
  features: ArcgisFeature[];
  /** Features dropped because no id could be found. */
  skippedWithoutId: number;
}

export interface FetchLayerDependencies {
  fetchFunction: typeof fetch;
}

interface GeoJsonFeature {
  id?: unknown;
  properties?: Record<string, unknown> | null;
  geometry?: unknown;
}

const ID_PROPERTY_NAMES = ["OBJECTID", "objectid", "FID"] as const;

function describeError(error: unknown): string {
  if (typeof error !== "object" || error === null) return JSON.stringify(error);
  const { code, message, details } = error as {
    code?: number;
    message?: string;
    details?: string[];
  };
  const detailText = Array.isArray(details) && details.length > 0 ? ` (${details.join("; ")})` : "";
  return `${code ?? "unknown code"}: ${message ?? "no message"}${detailText}`;
}

/** ArcGIS reports many failures as HTTP 200 with a JSON `{ error }` body. */
async function getJson(fetchFunction: typeof fetch, url: URL): Promise<Record<string, unknown>> {
  const response = await fetchFunction(url.toString());
  if (!response.ok) {
    throw new Error(
      `ArcGIS request failed with HTTP ${response.status}: ${url.origin}${url.pathname}`,
    );
  }
  const body = (await response.json()) as Record<string, unknown>;
  if (body.error) {
    throw new Error(
      `ArcGIS returned an error for ${url.origin}${url.pathname} - ${describeError(body.error)}`,
    );
  }
  return body;
}

async function readPageSize(fetchFunction: typeof fetch, layerUrl: string): Promise<number> {
  try {
    const metadata = await getJson(fetchFunction, new URL(`${layerUrl}?f=json`));
    const maxRecordCount = metadata.maxRecordCount;
    if (typeof maxRecordCount === "number" && maxRecordCount > 0) return maxRecordCount;
  } catch {
    // Metadata is only a hint for the page size; fall back to the default.
  }
  return DEFAULT_PAGE_SIZE;
}

function reportsMoreData(page: Record<string, unknown>): boolean {
  const properties = page.properties as Record<string, unknown> | null | undefined;
  return page.exceededTransferLimit === true || properties?.exceededTransferLimit === true;
}

function extractId(feature: GeoJsonFeature): string | undefined {
  const candidates = [feature.id, ...ID_PROPERTY_NAMES.map((name) => feature.properties?.[name])];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === "") continue;
    if (typeof candidate === "string" || typeof candidate === "number") return String(candidate);
  }
  return undefined;
}

/**
 * Fetch every feature of an ArcGIS layer as GeoJSON in WGS84 (4326), paging with
 * `resultOffset`/`resultRecordCount`. Throws if any request fails, so a caller
 * never receives a partial result.
 */
export async function fetchLayerFeatures(
  layerUrl: string,
  { fetchFunction }: FetchLayerDependencies,
): Promise<FetchedLayer> {
  const pageSize = await readPageSize(fetchFunction, layerUrl);
  const featuresById = new Map<string, ArcgisFeature>();
  let skippedWithoutId = 0;

  for (let offset = 0; ; offset += pageSize) {
    const url = new URL(`${layerUrl}/query`);
    url.searchParams.set("where", "1=1");
    url.searchParams.set("outFields", "*");
    url.searchParams.set("outSR", "4326");
    url.searchParams.set("f", "geojson");
    url.searchParams.set("resultOffset", String(offset));
    url.searchParams.set("resultRecordCount", String(pageSize));

    const page = await getJson(fetchFunction, url);
    const pageFeatures = Array.isArray(page.features) ? (page.features as GeoJsonFeature[]) : [];

    for (const feature of pageFeatures) {
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

    // Servers report "more data" at the top level, inside `properties`, both or
    // neither, so a full page also counts: a missing flag must never truncate.
    const hasMore = reportsMoreData(page) || pageFeatures.length >= pageSize;
    if (pageFeatures.length === 0 || !hasMore) break;
  }

  return { features: [...featuresById.values()], skippedWithoutId };
}
