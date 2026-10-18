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
const trackedRoads: LayerConfig = { ...roads, editDateField: "EDIT_DATE" };
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

interface Statistics {
  count: number;
  latestEdit: string | null;
}

/**
 * ArcGIS stand-in: layer URL -> features, or an Error to answer with a JSON error body.
 * `statistics` answers edit-date statistics queries per layer URL; a layer without an
 * entry (or with an Error) answers them with an error, as a server without support would.
 */
function arcgis(
  layers: Record<string, unknown[] | Error>,
  statistics: Record<string, Statistics | Error> = {},
) {
  const requested: string[] = [];
  const downloads: string[] = [];
  // The Esri client always calls the global `fetch`.
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const layerUrl = url.origin + url.pathname.replace(/\/query$/, "");
    requested.push(layerUrl);
    const served = layers[layerUrl];
    if (!url.pathname.endsWith("/query")) return Response.json({ maxRecordCount: 100 });
    if (url.searchParams.has("outStatistics")) {
      const answer = statistics[layerUrl];
      if (!answer || answer instanceof Error) {
        return Response.json({
          error: { code: 400, message: answer?.message ?? "Unsupported operation" },
        });
      }
      return Response.json({
        features: [
          {
            attributes: {
              feature_count: answer.count,
              latest_edit: answer.latestEdit === null ? null : Date.parse(answer.latestEdit),
            },
          },
        ],
      });
    }
    if (url.searchParams.get("returnCountOnly") === "true") {
      return Response.json({ count: Array.isArray(served) ? served.length : 0 });
    }
    downloads.push(layerUrl);
    if (served instanceof Error)
      return Response.json({ error: { code: 500, message: served.message } });
    return Response.json({ type: "FeatureCollection", features: served ?? [] });
  });
  return { requested, downloads };
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

  describe("skipping unchanged layers", () => {
    const firstRun = new Date("2026-01-05T06:00:00Z");
    const secondRun = new Date("2026-01-12T06:00:00Z");
    const edited = "2026-01-02T15:30:00.000Z";
    const unchangedStatistics = { [roadsUrl]: { count: 2, latestEdit: edited } };

    const layerState = async () =>
      (
        await rows(sql`
          SELECT last_synced_at, source_feature_count, source_last_edited_at
          FROM open_data_sync.arcgis_raw_layers WHERE service_url = ${roadsUrl}`)
      )[0]!;
    const featureState = async () =>
      rows(sql`
        SELECT source_feature_id, attributes->>'NAME' AS name, synced_at, xmin::text AS version
        FROM open_data_sync.arcgis_raw_features ORDER BY source_feature_id`);
    const iso = (value: unknown) => new Date(value as string).toISOString();

    it("adds nullable fingerprint columns to the layers table", async () => {
      const columns = await rows(sql`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'open_data_sync' AND table_name = 'arcgis_raw_layers'
          AND column_name IN ('source_feature_count', 'source_last_edited_at')
        ORDER BY column_name`);
      expect(columns).toEqual([
        { column_name: "source_feature_count", data_type: "integer", is_nullable: "YES" },
        {
          column_name: "source_last_edited_at",
          data_type: "timestamp with time zone",
          is_nullable: "YES",
        },
      ]);
    });

    it("downloads in full on the first run and stores the fingerprint", async () => {
      arcgis({ [roadsUrl]: [geoJsonFeature(1), geoJsonFeature(2)] }, unchangedStatistics);
      const results = await syncAllLayers(dependencies(firstRun), [trackedRoads]);

      expect(results[0]).toMatchObject({ fetched: 2, upserted: 2, unchanged: false });
      const layer = await layerState();
      expect(layer.source_feature_count).toBe(2);
      expect(iso(layer.source_last_edited_at)).toBe(edited);
    });

    it("leaves feature rows untouched and advances last_synced_at when the source is unchanged", async () => {
      arcgis({ [roadsUrl]: [geoJsonFeature(1), geoJsonFeature(2)] }, unchangedStatistics);
      await syncAllLayers(dependencies(firstRun), [trackedRoads]);
      const featuresBefore = await featureState();

      // Were the layer downloaded again, it would now answer with different data.
      const { downloads } = arcgis(
        { [roadsUrl]: [geoJsonFeature(1, line, { NAME: "changed" })] },
        unchangedStatistics,
      );
      const logged: string[] = [];
      const results = await syncAllLayers(
        { ...dependencies(secondRun), log: (message) => logged.push(message) },
        [trackedRoads],
      );

      expect(downloads).toEqual([]);
      expect(await featureState()).toEqual(featuresBefore);
      expect(iso((await layerState()).last_synced_at)).toBe(secondRun.toISOString());
      expect(results[0]).toMatchObject({
        unchanged: true,
        fetched: 0,
        upserted: 0,
        deleted: 0,
      });
      expect(logged).toContain(
        `Skipped Roads: unchanged, source last edited ${edited}, last synced ${firstRun.toISOString()}`,
      );
      expect(
        logged.some((message) => message.includes(roadsUrl) && message.includes("unchanged")),
      ).toBe(true);
    });

    it("downloads in full and stores the new fingerprint when the source changed", async () => {
      arcgis({ [roadsUrl]: [geoJsonFeature(1), geoJsonFeature(2)] }, unchangedStatistics);
      await syncAllLayers(dependencies(firstRun), [trackedRoads]);

      const newEdit = "2026-01-10T09:00:00.000Z";
      const { downloads } = arcgis(
        { [roadsUrl]: [geoJsonFeature(2, line, { NAME: "renamed" }), geoJsonFeature(3)] },
        { [roadsUrl]: { count: 2, latestEdit: newEdit } },
      );
      const results = await syncAllLayers(dependencies(secondRun), [trackedRoads]);

      expect(downloads).toEqual([roadsUrl]);
      expect(results[0]).toMatchObject({ unchanged: false, upserted: 2, deleted: 1 });
      expect((await featureState()).map((row) => [row.source_feature_id, row.name])).toEqual([
        ["2", "renamed"],
        ["3", "feature 3"],
      ]);
      const layer = await layerState();
      expect(layer.source_feature_count).toBe(2);
      expect(iso(layer.source_last_edited_at)).toBe(newEdit);
      expect(iso(layer.last_synced_at)).toBe(secondRun.toISOString());
    });

    it("falls back to a full sync, without failing the layer, when statistics are unsupported", async () => {
      arcgis({ [roadsUrl]: [geoJsonFeature(1), geoJsonFeature(2)] }, unchangedStatistics);
      await syncAllLayers(dependencies(firstRun), [trackedRoads]);

      const { downloads } = arcgis({ [roadsUrl]: [geoJsonFeature(1), geoJsonFeature(2)] });
      const logged: string[] = [];
      const results = await syncAllLayers(
        { ...dependencies(secondRun), log: (message) => logged.push(message) },
        [trackedRoads],
      );

      expect(downloads).toEqual([roadsUrl]);
      expect(results[0]!.error).toBeUndefined();
      expect(logged.join("\n")).toContain("Unsupported operation");
      // The new source state is unknown, so no stale fingerprint may be left behind.
      const layer = await layerState();
      expect(layer.source_feature_count).toBeNull();
      expect(layer.source_last_edited_at).toBeNull();
    });

    it("does not save a fingerprint when the layer fails, so the next run downloads again", async () => {
      arcgis({ [roadsUrl]: new Error("service down") }, unchangedStatistics);
      await expect(syncAllLayers(dependencies(firstRun), [trackedRoads])).rejects.toThrow(roadsUrl);
      const failed = await layerState();
      expect(failed.source_feature_count).toBeNull();
      expect(failed.source_last_edited_at).toBeNull();

      const { downloads } = arcgis({ [roadsUrl]: [geoJsonFeature(1)] }, unchangedStatistics);
      await syncAllLayers(dependencies(secondRun), [trackedRoads]);
      expect(downloads).toEqual([roadsUrl]);
    });

    it("keeps the previous fingerprint when a changed layer then fails", async () => {
      arcgis({ [roadsUrl]: [geoJsonFeature(1), geoJsonFeature(2)] }, unchangedStatistics);
      await syncAllLayers(dependencies(firstRun), [trackedRoads]);

      arcgis(
        { [roadsUrl]: new Error("service down") },
        { [roadsUrl]: { count: 5, latestEdit: "2026-01-10T09:00:00.000Z" } },
      );
      await expect(syncAllLayers(dependencies(secondRun), [trackedRoads])).rejects.toThrow(
        roadsUrl,
      );
      const layer = await layerState();
      expect(layer.source_feature_count).toBe(2);
      expect(iso(layer.source_last_edited_at)).toBe(edited);
      expect(iso(layer.last_synced_at)).toBe(firstRun.toISOString());
    });

    it("never asks a layer without an edit-date field for statistics", async () => {
      const { requested } = arcgis({ [roadsUrl]: [geoJsonFeature(1)] });
      await syncAllLayers(dependencies(firstRun), [roads]);
      await syncAllLayers(dependencies(secondRun), [roads]);
      const layer = await layerState();
      expect(layer.source_feature_count).toBeNull();
      expect(requested.filter((url) => url === roadsUrl).length).toBeGreaterThan(2);
    });
  });

  describe("bootstrap", () => {
    const layerRow = async () =>
      (
        await rows(sql`
          SELECT xmin::text AS version, updated_at::text AS updated_at, name, data_group
          FROM open_data_sync.arcgis_raw_layers WHERE service_url = ${roadsUrl}`)
      )[0]!;

    it("does not rewrite a layer row whose values are unchanged", async () => {
      await bootstrapLayers(testDatabase.database, [roads]);
      const before = await layerRow();
      await bootstrapLayers(testDatabase.database, [roads]);
      expect(await layerRow()).toEqual(before);
    });

    it("updates a layer row when its name or data group changed", async () => {
      await bootstrapLayers(testDatabase.database, [roads]);
      const before = await layerRow();
      await bootstrapLayers(testDatabase.database, [
        { ...roads, name: "Renamed roads", dataGroup: "intersections" },
      ]);
      const after = await layerRow();
      expect(after).toMatchObject({ name: "Renamed roads", data_group: "intersections" });
      expect(after.version).not.toBe(before.version);
      expect(after.updated_at).not.toBe(before.updated_at);
    });
  });

  describe("re-syncing features", () => {
    const featureRow = async () =>
      (
        await rows(sql`
          SELECT attributes->>'NAME' AS name, ST_AsText(geometry) AS wkt, synced_at
          FROM open_data_sync.arcgis_raw_features WHERE source_feature_id = '1'`)
      )[0]!;
    const syncOnce = async (feature: object, day: number) => {
      arcgis({ [roadsUrl]: [feature] });
      await syncAllLayers(
        dependencies(new Date(`2026-01-${String(day).padStart(2, "0")}T06:00:00Z`)),
        [roads],
      );
    };
    const reversed = {
      type: "LineString",
      coordinates: [
        [-79.7, 43.6],
        [-79.8, 43.5],
      ],
    };

    it("keeps identical data and advances synced_at", async () => {
      await syncOnce(geoJsonFeature(1), 5);
      const before = await featureRow();
      await syncOnce(geoJsonFeature(1), 12);
      const after = await featureRow();
      expect({ name: after.name, wkt: after.wkt }).toEqual({ name: before.name, wkt: before.wkt });
      expect(new Date(after.synced_at as string).toISOString()).toBe("2026-01-12T06:00:00.000Z");
    });

    it("keeps a null geometry null when re-sent", async () => {
      await syncOnce(geoJsonFeature(1, null), 5);
      await syncOnce(geoJsonFeature(1, null), 12);
      expect((await featureRow()).wkt).toBeNull();
    });

    it("updates changed attributes and changed geometry, including null to a shape and back", async () => {
      await syncOnce(geoJsonFeature(1, null), 5);
      await syncOnce(geoJsonFeature(1, line, { NAME: "changed" }), 12);
      expect(await featureRow()).toMatchObject({
        name: "changed",
        wkt: "LINESTRING(-79.8 43.5,-79.7 43.6)",
      });
      await syncOnce(geoJsonFeature(1, reversed, { NAME: "changed" }), 19);
      expect((await featureRow()).wkt).toBe("LINESTRING(-79.7 43.6,-79.8 43.5)");
      await syncOnce(geoJsonFeature(1, null, { NAME: "changed" }), 26);
      expect((await featureRow()).wkt).toBeNull();
    });
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
