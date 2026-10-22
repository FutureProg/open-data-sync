import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { logIntegrationQa, refreshCurated } from "../../src/curated";
import { syncAllLayers } from "../../src/sync";
import { isDockerAvailable, startTestDatabase, type TestDatabase } from "./postgis";

/**
 * Opt-in baseline against the real thing: downloads the live ArcGIS layers into a throwaway
 * PostGIS container, loads the 2024 HRPS backfill export, runs the curated refresh and checks
 * the data quality numbers. It hits four municipal servers, so it is not part of the normal run:
 *
 *   HRPS_BACKFILL_GEOJSON=/path/to/crime_map_jan_1_2024.geojson pnpm exec vp test run tests/integration/baseline.test.ts
 *
 * The export is police data and is not committed to this repo.
 */
const exportPath = process.env.HRPS_BACKFILL_GEOJSON;
const enabled = Boolean(exportPath) && isDockerAvailable();
if (!enabled) console.warn("Set HRPS_BACKFILL_GEOJSON (and run Docker) to run the baseline test.");

interface ExportFeature {
  properties: Record<string, string | null>;
}

describe.skipIf(!enabled)("2024 backfill baseline", () => {
  let db: TestDatabase;
  let qa: Record<string, unknown>;

  beforeAll(async () => {
    db = await startTestDatabase();
    await syncAllLayers({ database: db.database, now: () => new Date(), log: () => {} });
    const { features } = JSON.parse(readFileSync(exportPath!, "utf8")) as {
      features: ExportFeature[];
    };
    const rows = features.map(({ properties: p }) => [
      p.CASE_NO,
      new Date(p.DATE!).toISOString(),
      p.DESCRIPTION!.trim(),
      p.LOCATION,
      p.CITY,
      Number(p.Latitude),
      Number(p.Longitude),
      p.GlobalID,
    ]);
    for (let start = 0; start < rows.length; start += 1000) {
      const batch = rows.slice(start, start + 1000);
      const params = batch.flat();
      const tuples = batch
        .map((_, i) => `(${Array.from({ length: 8 }, (_, j) => `$${i * 8 + j + 1}`).join(",")})`)
        .join(",");
      await db.query(
        `INSERT INTO safe_streets_halton.hrps_data
           (case_no, date, description, location, city, latitude, longitude, "globalId") VALUES ${tuples}`,
        params,
      );
    }
    await refreshCurated(db.database, console.log);
    qa = (await db.query("SELECT * FROM open_data_sync.integration_qa")).rows[0]!;
    await logIntegrationQa(db.database, console.log);
  }, 900_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("locates every incident", () => {
    expect(Number(qa.incidents_total)).toBe(6634);
    expect(Number(qa.incidents_unlocated)).toBe(0);
  });

  it("knows every description in the export", () => {
    expect(qa.unknown_descriptions).toEqual([]);
  });

  it("derives a point near every intersection Burlington publishes", async () => {
    // Burlington's own layer is a check, not a source: report any published point with no derived one within 15 m.
    const { rows } = await db.query(`
      SELECT f.attributes ->> 'STREET1' AS street1, f.attributes ->> 'STREET2' AS street2,
             round(ST_X(f.geometry)::numeric, 5) AS x, round(ST_Y(f.geometry)::numeric, 5) AS y
      FROM open_data_sync.arcgis_raw_features f
      WHERE f.data_group = 'intersections' AND f.geometry IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM open_data_sync.intersections i
          WHERE ST_DWithin(i.geom_m, ST_Transform(f.geometry, 2958), 15))`);
    const { rows: total } = await db.query(
      "SELECT count(*) AS n FROM open_data_sync.arcgis_raw_features WHERE data_group = 'intersections'",
    );
    console.log(
      `Burlington published ${String(total[0]!.n)}; ${rows.length} without a derived point within 15 m`,
    );
    console.log(JSON.stringify(rows.slice(0, 40)));
    // Most misses are crescent and court legs that share one name, or driveways and ramps: not
    // street-to-street intersections. 2.6% on 2026-10-22 (63 of 2,378).
    expect(rows.length / Number(total[0]!.n)).toBeLessThan(0.05);
  });

  it("stays inside the baseline set on 2026-10-22 (6,634 incidents)", () => {
    expect(Number(qa.incidents_without_ward)).toBe(0);
    // 59 on the day: incidents whose police town differs from the ward polygon's town.
    expect(Number(qa.ward_town_mismatches)).toBeLessThan(100);
    // 98.1% on the day; HRPS geocodes most traffic incidents to an intersection.
    expect(Number(qa.share_near_intersection)).toBeGreaterThan(0.95);
    const perTown = qa.intersections_per_town as Record<string, number>;
    expect(Object.keys(perTown).sort()).toEqual([
      "Burlington",
      "Halton Hills",
      "Milton",
      "Oakville",
    ]);
    for (const count of Object.values(perTown)) expect(count).toBeGreaterThan(500);
  });
});
