import type { CloudEnv } from "void";

/** Worker bindings available to cron handlers. */
export type SyncEnv = CloudEnv["Bindings"];

/** A feature as returned by ArcGIS in `f=json`/`f=geojson` form (shape TBD). */
export interface ArcgisFeature {
  /** OBJECTID or GlobalID, stringified. */
  sourceFeatureId: string;
  attributes: Record<string, unknown>;
  /** GeoJSON geometry in SRID 4326, or null/undefined when the feature has none. */
  geometry: unknown;
}
