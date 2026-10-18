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
  /**
   * Name of the layer's last-edited date field. When set, the sync first asks the
   * source for its feature count and latest edit date, and skips the download if
   * both match what the previous sync stored. Leave unset to always fetch in full.
   */
  editDateField?: string;
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
    editDateField: "LAST_EDITED_DATE",
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
    url: "https://maps.oakville.ca/oakgis/rest/services/SBS/Road_Segments/FeatureServer/21",
    editDateField: "last_edited_date",
  },
  {
    town: "Burlington",
    dataGroup: "ward_boundaries",
    name: "Burlington wards",
    url: "https://mapping.burlington.ca/arcgisweb/rest/services/COB/WardBoundaries/MapServer/0",
    editDateField: "LAST_EDITED_DATE",
  },
  {
    town: "Oakville",
    dataGroup: "ward_boundaries",
    name: "Oakville wards",
    url: "https://services5.arcgis.com/QJebCdoMf4PF8fJP/arcgis/rest/services/Wards/FeatureServer/0",
  },
  {
    town: "Milton",
    dataGroup: "ward_boundaries",
    name: "Milton wards",
    url: "https://api.milton.ca/arcgis/rest/services/Datasets/Wards/MapServer/0",
  },
  {
    town: "Milton",
    dataGroup: "road_segments",
    name: "Milton road segments",
    url: "https://api.milton.ca/arcgis/rest/services/Datasets/Roads/MapServer/0",
    editDateField: "EDIT_DATE",
  },
];

/** True if the layer's URL has been resolved and can be synced. */
export function isResolved(layer: LayerConfig): boolean {
  return layer.url !== TODO_URL;
}
