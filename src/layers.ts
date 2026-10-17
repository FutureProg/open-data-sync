/**
 * Seed/config list of the ArcGIS layers to sync.
 *
 * This is data only. A future bootstrap step will upsert these into
 * `open_data_sync.arcgis_raw_layers` (keyed on `url`).
 * Layers whose `url` is `TODO` are skipped until the URL is resolved.
 */

export const TOWNS = ["Burlington", "Oakville", "Milton", "Halton Hills"] as const;
export type Town = (typeof TOWNS)[number];

export const DATA_GROUPS = ["ward_boundaries", "road_segments", "intersections"] as const;
export type DataGroup = (typeof DATA_GROUPS)[number];

/** Placeholder for service URLs not yet resolved. */
export const TODO_URL = "TODO" as const;

export interface LayerConfig {
  town: Town;
  dataGroup: DataGroup;
  name: string;
  /** ArcGIS layer URL ending in /MapServer/N or /FeatureServer/N, or `TODO`. */
  url: string;
}

export const LAYERS: readonly LayerConfig[] = [
  {
    town: "Halton Hills",
    dataGroup: "ward_boundaries",
    name: "Halton Hills wards",
    url: "https://map.haltonhills.ca/awse/rest/services/eP/MapServer/28",
  },
  {
    town: "Halton Hills",
    dataGroup: "road_segments",
    name: "Halton Hills roads (HH_SLSN_id001)",
    url: "https://map.haltonhills.ca/awse/rest/services/eP/MapServer/16",
  },
  {
    town: "Burlington",
    dataGroup: "road_segments",
    name: "Burlington road segments",
    url: "https://mapping.burlington.ca/arcgisweb/rest/services/COB/Road_Segments/MapServer/0",
  },
  {
    town: "Burlington",
    dataGroup: "intersections",
    name: "Burlington intersections",
    url: "https://mapping.burlington.ca/arcgisweb/rest/services/COB/Intersections/MapServer/0",
  },
  {
    town: "Oakville",
    dataGroup: "road_segments",
    name: "Oakville road network",
    // TODO: layer index unknown. Base service:
    // https://maps.oakville.ca/oakgis/rest/services/SBS/Road_Segments/FeatureServer
    url: TODO_URL,
  },
  {
    town: "Burlington",
    dataGroup: "ward_boundaries",
    name: "Burlington wards",
    // TODO: resolve service URL. ArcGIS Hub item 73bee9ff196141a2a1e45be8c04ae404
    url: TODO_URL,
  },
  {
    town: "Oakville",
    dataGroup: "ward_boundaries",
    name: "Oakville wards",
    // TODO: resolve service URL. ArcGIS Hub item 06e1062918f043258ebcada195527120
    url: TODO_URL,
  },
  {
    town: "Milton",
    dataGroup: "ward_boundaries",
    name: "Milton wards",
    // TODO: resolve service URL. ArcGIS Hub item 33fd808004c449afba2bc80587ac2889
    url: TODO_URL,
  },
  {
    town: "Milton",
    dataGroup: "road_segments",
    name: "Milton road segments",
    // TODO: resolve service URL. ArcGIS Hub item 035fd4a9a3684bf5b6db2e9d36a4d3b1
    url: TODO_URL,
  },
];

/** True if the layer's URL has been resolved and can be synced. */
export function isResolved(layer: LayerConfig): boolean {
  return layer.url !== TODO_URL;
}
