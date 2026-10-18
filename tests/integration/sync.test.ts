import { sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import type { LayerConfig } from "../../src/layers";
import { bootstrapLayers, listEnabledLayers, writeLayerFeatures } from "../../src/layer-store";
import { syncAllLayers } from "../../src/sync";
import { isDockerAvailable, startTestDatabase, type TestDatabase } from "./postgis";

const dockerAvailable = isDockerAvailable();
if (!dockerAvailable) {
  console.warn("Docker is not available: skipping the PostGIS integration tests.");
}

const roadsUrl = "https://gis.example.test/rest/services/Roads/MapServer/0";
const wardsUrl = "https://gis.example.test/rest/services/Wards/MapServer/1";

const roads: LayerConfig = {
  town: "Milton",
  dataGroup: "road_segments",
  name: "Roads",
  url: roadsUrl,
};
const wards: LayerConfig = {
  town: "Milton",
  dataGroup: "ward_boundaries",
  name: "Wards",
  url: wardsUrl,
};
const unresolved: LayerConfig = {
  town: "Oakville",
  dataGroup: "road_segments",
  name: "Todo",
  url: "TODO",
};

const line = {
  type: "LineString",
  coordinates: [
    [-79.8, 43.5],
    [-79.7, 43.6],
  ],
};
const geoJsonFeature = (id: number, geometry: unknown = line, properties: object = {}) => ({
  type: "Feature",
  id,
  properties: { NAME: `feature ${id}`, ...properties },
  geometry,
});

/** ArcGIS stand-in: layer URL -> features, or an Error to answer with a JSON error body. */
function arcgis(layers: Record<string, unknown[] | Error>) {
  const requested: string[] = [];
  // The Esri client always calls the global `fetch`.
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const layerUrl = url.origin + url.pathname.replace(/\/query$/, "");
    requested.push(layerUrl);
    const served = layers[layerUrl];
    if (!url.pathname.endsWith("/query")) return Response.json({ maxRecordCount: 100 });
    if (url.searchParams.get("returnCountOnly") === "true") {
      return Response.json({ count: Array.isArray(served) ? served.length : 0 });
    }
    if (served instanceof Error)
      return Response.json({ error: { code: 500, message: served.message } });
    return Response.json({ type: "FeatureCollection", features: served ?? [] });
  });
  return { requested };
}

describe.skipIf(!dockerAvailable)("sync against PostGIS", () => {
  let testDatabase: TestDatabase;
  const dependencies = (now = new Date("2026-01-05T06:00:00Z")) => ({
    database: testDatabase.database,
    now: () => now,
    log: () => {},
  });
  const rows = async (query: ReturnType<typeof sql>) =>
    (await testDatabase.database.execute(query)).rows as Record<string, unknown>[];

  beforeAll(async () => {
    testDatabase = await startTestDatabase();
  }, 180_000);
  afterAll(async () => {
    await testDatabase?.stop();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  beforeEach(async () => {
    await testDatabase.reset();
  });

  it("stores features with attributes and 4326 PostGIS geometry, allowing null geometry", async () => {
    arcgis({ [roadsUrl]: [geoJsonFeature(1), geoJsonFeature(2, null)] });
    await syncAllLayers(dependencies(), [roads]);

    const stored = await rows(sql`
      SELECT source_feature_id, data_group, attributes->>'NAME' AS name,
             ST_SRID(geometry) AS srid, ST_AsText(geometry) AS wkt
      FROM open_data_sync.arcgis_raw_features ORDER BY source_feature_id`);
    expect(stored).toEqual([
      {
        source_feature_id: "1",
        data_group: "road_segments",
        name: "feature 1",
        srid: 4326,
        wkt: "LINESTRING(-79.8 43.5,-79.7 43.6)",
      },
      {
        source_feature_id: "2",
        data_group: "road_segments",
        name: "feature 2",
        srid: null,
        wkt: null,
      },
    ]);
  });

  it("updates rows in place on a second run and deletes features that disappeared", async () => {
    arcgis({ [roadsUrl]: [geoJsonFeature(1), geoJsonFeature(2)] });
    await syncAllLayers(dependencies(), [roads]);

    arcgis({
      [roadsUrl]: [geoJsonFeature(2, line, { NAME: "renamed" }), geoJsonFeature(3)],
    });
    const results = await syncAllLayers(dependencies(new Date("2026-01-12T06:00:00Z")), [roads]);

    const stored = await rows(sql`
      SELECT source_feature_id, attributes->>'NAME' AS name
      FROM open_data_sync.arcgis_raw_features ORDER BY source_feature_id`);
    expect(stored).toEqual([
      { source_feature_id: "2", name: "renamed" },
      { source_feature_id: "3", name: "feature 3" },
    ]);
    expect(results[0]).toMatchObject({ fetched: 2, upserted: 2, deleted: 1 });
    const [layer] = await rows(sql`SELECT last_synced_at FROM open_data_sync.arcgis_raw_layers`);
    expect(new Date(layer!.last_synced_at as string).toISOString()).toBe(
      "2026-01-12T06:00:00.000Z",
    );
  });

  it("keeps a failing layer's existing rows, still syncs the others, then throws", async () => {
    arcgis({ [roadsUrl]: [geoJsonFeature(1)], [wardsUrl]: [geoJsonFeature(10)] });
    await syncAllLayers(dependencies(), [roads, wards]);

    arcgis({
      [roadsUrl]: new Error("service down"),
      [wardsUrl]: [geoJsonFeature(11)],
    });
    const later = new Date("2026-01-12T06:00:00Z");
    await expect(syncAllLayers(dependencies(later), [roads, wards])).rejects.toThrow(roadsUrl);

    const stored = await rows(sql`
      SELECT l.service_url, f.source_feature_id FROM open_data_sync.arcgis_raw_features f
      JOIN open_data_sync.arcgis_raw_layers l ON l.id = f.layer_id ORDER BY f.source_feature_id`);
    expect(stored).toEqual([
      { service_url: roadsUrl, source_feature_id: "1" }, // not deleted: its fetch failed
      { service_url: wardsUrl, source_feature_id: "11" }, // synced despite the other failure
    ]);
  });

  it("fails a populated layer that suddenly returns zero features, keeping its rows", async () => {
    arcgis({ [roadsUrl]: [geoJsonFeature(1)], [wardsUrl]: [geoJsonFeature(10)] });
    await syncAllLayers(dependencies(), [roads, wards]);

    const later = new Date("2026-01-12T06:00:00Z");
    arcgis({ [roadsUrl]: [], [wardsUrl]: [geoJsonFeature(11)] });
    const logged: string[] = [];
    await expect(
      syncAllLayers({ ...dependencies(later), log: (m) => logged.push(m) }, [roads, wards]),
    ).rejects.toThrow(roadsUrl);

    expect(logged.join("\n")).toContain("returned 0 features but 1 rows exist");
    const stored = await rows(sql`
      SELECT l.service_url, f.source_feature_id, l.last_synced_at
      FROM open_data_sync.arcgis_raw_features f
      JOIN open_data_sync.arcgis_raw_layers l ON l.id = f.layer_id ORDER BY f.source_feature_id`);
    expect(stored.map((r) => [r.service_url, r.source_feature_id])).toEqual([
      [roadsUrl, "1"],
      [wardsUrl, "11"],
    ]);
    expect(new Date(stored[0]!.last_synced_at as string).toISOString()).toBe(
      "2026-01-05T06:00:00.000Z",
    );
  });

  it("does not fail an empty layer that has no stored rows", async () => {
    arcgis({ [roadsUrl]: [] });
    const results = await syncAllLayers(dependencies(), [roads]);
    expect(results[0]).toMatchObject({ fetched: 0, upserted: 0, deleted: 0 });
    expect(results[0]!.error).toBeUndefined();
  });

  it("skips unresolved layers and never fetches or re-enables disabled ones", async () => {
    await bootstrapLayers(testDatabase.database, [roads, wards]);
    await testDatabase.database.execute(
      sql`UPDATE open_data_sync.arcgis_raw_layers SET enabled = false WHERE service_url = ${wardsUrl}`,
    );
    const { requested } = arcgis({
      [roadsUrl]: [geoJsonFeature(1)],
      [wardsUrl]: [geoJsonFeature(2)],
    });

    await syncAllLayers(dependencies(), [roads, wards, unresolved]);

    expect(new Set(requested)).toEqual(new Set([roadsUrl]));
    const layers = await rows(
      sql`SELECT service_url, enabled FROM open_data_sync.arcgis_raw_layers ORDER BY id`,
    );
    expect(layers).toEqual([
      { service_url: roadsUrl, enabled: true },
      { service_url: wardsUrl, enabled: false },
    ]);
  });

  it("writes large layers in several batches", async () => {
    await bootstrapLayers(testDatabase.database, [roads]);
    const [layer] = await listEnabledLayers(testDatabase.database);
    const features = [1, 2, 3, 4, 5].map((id) => ({
      sourceFeatureId: String(id),
      attributes: { id },
      geometry: line,
    }));
    const outcome = await writeLayerFeatures(
      testDatabase.database,
      layer!,
      features,
      new Date(),
      2,
    );
    expect(outcome).toEqual({ upserted: 5, deleted: 0 });
    const [count] = await rows(
      sql`SELECT count(*)::int AS count FROM open_data_sync.arcgis_raw_features`,
    );
    expect(count!.count).toBe(5);
  });

  it("rolls back the whole layer write if a later batch fails", async () => {
    await bootstrapLayers(testDatabase.database, [roads]);
    const [layer] = await listEnabledLayers(testDatabase.database);
    const original = { sourceFeatureId: "1", attributes: { version: "old" }, geometry: line };
    await writeLayerFeatures(
      testDatabase.database,
      layer!,
      [original],
      new Date("2026-01-05T00:00:00Z"),
    );

    const invalidGeometry = { type: "Nonsense", coordinates: [] };
    const attempt = writeLayerFeatures(
      testDatabase.database,
      layer!,
      [
        { sourceFeatureId: "1", attributes: { version: "new" }, geometry: line },
        { sourceFeatureId: "2", attributes: {}, geometry: line },
        { sourceFeatureId: "3", attributes: {}, geometry: invalidGeometry },
      ],
      new Date("2026-01-12T00:00:00Z"),
      2,
    );
    await expect(attempt).rejects.toThrow();

    const stored = await rows(sql`
      SELECT source_feature_id, attributes->>'version' AS version FROM open_data_sync.arcgis_raw_features`);
    expect(stored).toEqual([{ source_feature_id: "1", version: "old" }]);
    const [layerRow] = await rows(sql`SELECT last_synced_at FROM open_data_sync.arcgis_raw_layers`);
    expect(new Date(layerRow!.last_synced_at as string).toISOString()).toBe(
      "2026-01-05T00:00:00.000Z",
    );
  });
});
