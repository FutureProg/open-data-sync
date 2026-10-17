import {
  bigserial,
  bigint,
  boolean,
  customType,
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/**
 * PostGIS geometry column, any geometry type, SRID 4326. Drizzle's built-in
 * `geometry()` only emits `geometry(point)`, so this uses a customType.
 * Values are passed as GeoJSON/WKT text and converted in SQL (ST_GeomFromGeoJSON /
 * ST_SetSRID) by the upsert code, so no driver-level mapping is defined here.
 */
const geometry4326 = customType<{ data: string; driverData: string }>({
  dataType() {
    return "geometry(Geometry,4326)";
  },
});

/**
 * All tables live in the pre-existing `open_data_sync` schema. Migrations never
 * create or drop anything outside it, and never run CREATE EXTENSION (PostGIS is
 * already enabled by the database owner).
 */
export const openDataSync = pgSchema("open_data_sync");

/** One row per ArcGIS layer (MapServer/FeatureServer layer URL) we sync. */
export const arcgisRawLayers = openDataSync.table("arcgis_raw_layers", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  /** Burlington | Oakville | Milton | Halton Hills */
  town: text("town").notNull(),
  /** e.g. 'ward_boundaries', 'road_segments', 'intersections' */
  dataGroup: text("data_group").notNull(),
  name: text("name"),
  /** ArcGIS layer URL ending in /MapServer/N or /FeatureServer/N */
  serviceUrl: text("service_url").notNull().unique(),
  enabled: boolean("enabled").notNull().default(true),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One row per feature, stored raw (attributes as JSON, geometry as PostGIS). */
export const arcgisRawFeatures = openDataSync.table(
  "arcgis_raw_features",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    layerId: bigint("layer_id", { mode: "number" })
      .notNull()
      .references(() => arcgisRawLayers.id, { onDelete: "cascade" }),
    /** Denormalized from the layer so queries can filter without a join. */
    dataGroup: text("data_group").notNull(),
    /** ArcGIS OBJECTID or GlobalID, as text. */
    sourceFeatureId: text("source_feature_id").notNull(),
    attributes: jsonb("attributes").notNull(),
    /** Any geometry type, SRID 4326. */
    geometry: geometry4326("geometry"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("arcgis_raw_features_layer_source_uq").on(t.layerId, t.sourceFeatureId),
    index("arcgis_raw_features_data_group_idx").on(t.dataGroup),
    index("arcgis_raw_features_layer_id_idx").on(t.layerId),
    index("arcgis_raw_features_geometry_gist").using("gist", t.geometry),
  ],
);

export type ArcgisRawLayer = typeof arcgisRawLayers.$inferSelect;
export type NewArcgisRawLayer = typeof arcgisRawLayers.$inferInsert;
export type ArcgisRawFeature = typeof arcgisRawFeatures.$inferSelect;
export type NewArcgisRawFeature = typeof arcgisRawFeatures.$inferInsert;
