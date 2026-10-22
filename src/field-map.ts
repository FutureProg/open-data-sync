import type { DataGroup, Town } from "./layers";

/**
 * Which attribute of each town's layer holds the fields the curated views need.
 * Each town names them differently. A migration copies this into
 * `geo.layer_field_map` so the SQL can read it; a test fails if the two drift.
 * Field names were read off each layer's ArcGIS metadata.
 */
export interface LayerFieldMapping {
  town: Town;
  dataGroup: Extract<DataGroup, "ward_boundaries" | "road_segments">;
  /** Ward layers: attribute with the ward number (digits are extracted, so "Ward 3" works). */
  wardNumberField?: string;
  /** Ward layers: attribute with a ward name, when the source has one. */
  wardNameField?: string;
  /** Road layers: attribute with the full street name. */
  streetNameField?: string;
  /** Road layers: attribute with the road class, when the source has one. */
  roadClassField?: string;
}

export const FIELD_MAP: readonly LayerFieldMapping[] = [
  { town: "Burlington", dataGroup: "ward_boundaries", wardNumberField: "WARD_NO_INTEGER" },
  {
    town: "Oakville",
    dataGroup: "ward_boundaries",
    wardNumberField: "Ward",
    wardNameField: "FULL_NAME",
  },
  {
    town: "Milton",
    dataGroup: "ward_boundaries",
    wardNumberField: "WARD_NUM",
    wardNameField: "Name",
  },
  { town: "Halton Hills", dataGroup: "ward_boundaries", wardNumberField: "WARD" },
  {
    town: "Burlington",
    dataGroup: "road_segments",
    streetNameField: "MOFULLNAME",
    roadClassField: "STREET_CLASS",
  },
  {
    town: "Oakville",
    dataGroup: "road_segments",
    streetNameField: "FULL_STREET_NAME",
    roadClassField: "STREET_CLA",
  },
  {
    town: "Milton",
    dataGroup: "road_segments",
    streetNameField: "DISPLAY_NAME",
    roadClassField: "ROADCLASS",
  },
  { town: "Halton Hills", dataGroup: "road_segments", streetNameField: "STR_FULL" },
];
