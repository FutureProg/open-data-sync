import {
  bigserial,
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  varchar,
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
  /**
   * Fingerprint of the source as of the last full sync: its feature count and
   * latest edit date. Null until a layer with an edit-date field has synced.
   */
  sourceFeatureCount: integer("source_feature_count"),
  sourceLastEditedAt: timestamp("source_last_edited_at", { withTimezone: true }),
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

/** PostGIS point column, SRID 4326 (see `geometry4326` for why this is a customType). */
const point4326 = customType<{ data: string; driverData: string }>({
  dataType() {
    return "geometry(Point,4326)";
  },
});

/**
 * Which attribute of each layer holds the ward number, ward name, street name and
 * road class. Seeded by a migration from `src/field-map.ts`; a test keeps the two in sync.
 * Read by the curated materialized views (see `0003_curated_views.sql`).
 */
export const layerFieldMap = openDataSync.table(
  "layer_field_map",
  {
    town: text("town").notNull(),
    dataGroup: text("data_group").notNull(),
    wardNumberField: text("ward_number_field"),
    wardNameField: text("ward_name_field"),
    streetNameField: text("street_name_field"),
    roadClassField: text("road_class_field"),
  },
  (t) => [primaryKey({ columns: [t.town, t.dataGroup] })],
);

/** How each HRPS incident description is grouped (collision, injury or fatal). */
export const incidentTypeGroups = openDataSync.table("incident_type_groups", {
  /** Trimmed, upper-case HRPS description, e.g. 'MVC - PI'. */
  description: text("description").primaryKey(),
  isCollision: boolean("is_collision").notNull(),
  isInjuryOrFatal: boolean("is_injury_or_fatal").notNull(),
});

/**
 * One row per HRPS incident (`safe_streets_halton.hrps_data`, keyed by "globalId"):
 * its town, ward and nearest intersection. No foreign key: the two tables belong to
 * different repos. Filled by `open_data_sync.refresh_incident_locations()`.
 */
export const incidentLocations = openDataSync.table(
  "incident_locations",
  {
    globalId: varchar("global_id", { length: 255 }).primaryKey(),
    town: text("town"),
    wardId: text("ward_id"),
    wardTown: text("ward_town"),
    intersectionId: text("intersection_id"),
    distanceToIntersectionM: real("distance_to_intersection_m"),
    geom: point4326("geom").notNull(),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("incident_locations_geom_gist").using("gist", t.geom),
    index("incident_locations_ward_id_idx").on(t.wardId),
    index("incident_locations_intersection_id_idx").on(t.intersectionId),
  ],
);

/**
 * Read-only declarations of the curated views, which are created by raw SQL in
 * `0003_curated_views.sql` (Drizzle cannot express their recursive CTE, clustering and
 * lateral joins). `.existing()` keeps them out of generated migrations and gives typed selects.
 */
const geometryOf = (type: string, srid: number) =>
  customType<{ data: string; driverData: string }>({
    dataType() {
      return `geometry(${type},${srid})`;
    },
  });

export const wards = openDataSync
  .materializedView("wards", {
    wardId: text("ward_id").notNull(),
    town: text("town").notNull(),
    wardNumber: integer("ward_number").notNull(),
    wardName: text("ward_name").notNull(),
    geom: geometryOf("MultiPolygon", 4326)("geom").notNull(),
    geomM: geometryOf("MultiPolygon", 2958)("geom_m").notNull(),
    geomDisplay: geometryOf("MultiPolygon", 4326)("geom_display").notNull(),
  })
  .existing();

export const roadSegments = openDataSync
  .materializedView("road_segments", {
    segmentId: text("segment_id").notNull(),
    town: text("town").notNull(),
    streetName: text("street_name"),
    streetKey: text("street_key"),
    roadClass: text("road_class"),
    classRank: smallint("class_rank").notNull(),
    geomM: geometryOf("LineString", 2958)("geom_m").notNull(),
  })
  .existing();

export const intersections = openDataSync
  .materializedView("intersections", {
    intersectionId: text("intersection_id").notNull(),
    town: text("town").notNull(),
    streetNames: text("street_names").array().notNull(),
    label: text("label").notNull(),
    geom: geometryOf("Point", 4326)("geom").notNull(),
    geomM: geometryOf("Point", 2958)("geom_m").notNull(),
  })
  .existing();

export const integrationQa = openDataSync
  .view("integration_qa", {
    incidentsTotal: bigint("incidents_total", { mode: "number" }).notNull(),
    incidentsUnlocated: bigint("incidents_unlocated", { mode: "number" }).notNull(),
    incidentsWithoutWard: bigint("incidents_without_ward", { mode: "number" }).notNull(),
    wardTownMismatches: bigint("ward_town_mismatches", { mode: "number" }).notNull(),
    shareNearIntersection: numeric("share_near_intersection"),
    intersectionsPerTown: jsonb("intersections_per_town").$type<Record<string, number>>().notNull(),
    unknownDescriptionIncidents: bigint("unknown_description_incidents", {
      mode: "number",
    }).notNull(),
    unknownDescriptions: text("unknown_descriptions").array().notNull(),
  })
  .existing();
