import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { FIELD_MAP } from "../../src/field-map";
import { isDockerAvailable, startTestDatabase, type TestDatabase } from "./postgis";

const dockerAvailable = isDockerAvailable();
if (!dockerAvailable) {
  console.warn("Docker is not available: skipping the PostGIS integration tests.");
}

// Local plane around Halton (-79.8, 43.5): x metres east, y metres north.
const toLonLat = (x: number, y: number): [number, number] => [-79.8 + x / 80720, 43.5 + y / 111100];

type XY = [number, number];
const lineString = (points: XY[]) => ({
  type: "LineString",
  coordinates: points.map(([x, y]) => toLonLat(x, y)),
});
const rectangle = (x0: number, y0: number, x1: number, y1: number) => ({
  type: "Polygon",
  coordinates: [
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
      [x0, y0],
    ].map(([x, y]) => toLonLat(x!, y!)),
  ],
});

const roadFields = {
  Milton: { name: "DISPLAY_NAME", cls: "ROADCLASS" },
  Oakville: { name: "FULL_STREET_NAME", cls: "STREET_CLA" },
  Burlington: { name: "MOFULLNAME", cls: "STREET_CLASS" },
  "Halton Hills": { name: "STR_FULL", cls: undefined },
} as const;
type Town = keyof typeof roadFields;

describe.skipIf(!dockerAvailable)("curated views against PostGIS", () => {
  let db: TestDatabase;
  let featureCounter = 0;

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 180_000);
  afterAll(async () => {
    await db?.stop();
  });
  beforeEach(async () => {
    await db.reset();
    featureCounter = 0;
  });

  const rows = async (text: string, values?: unknown[]) => (await db.query(text, values)).rows;
  const scalar = async (text: string, values?: unknown[]) => {
    const [row] = await rows(text, values);
    return Object.values(row!)[0];
  };

  async function addFeature(
    town: string,
    dataGroup: string,
    attributes: Record<string, unknown>,
    geometry: unknown,
  ) {
    const [layer] = await rows(
      `INSERT INTO open_data_sync.arcgis_raw_layers (town, data_group, name, service_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (service_url) DO UPDATE SET name = excluded.name RETURNING id`,
      [town, dataGroup, `${town} ${dataGroup}`, `https://gis.example.test/${town}/${dataGroup}/0`],
    );
    featureCounter += 1;
    await db.query(
      `INSERT INTO open_data_sync.arcgis_raw_features
         (layer_id, data_group, source_feature_id, attributes, geometry, synced_at)
       VALUES ($1, $2, $3, $4::jsonb, ST_SetSRID(ST_GeomFromGeoJSON($5), 4326), now())`,
      [
        layer!.id,
        dataGroup,
        String(featureCounter),
        JSON.stringify(attributes),
        JSON.stringify(geometry),
      ],
    );
  }

  const addWard = (town: string, attributes: Record<string, unknown>, geometry: unknown) =>
    addFeature(town, "ward_boundaries", attributes, geometry);

  async function addRoad(town: Town, name: string, roadClass: string | undefined, ...points: XY[]) {
    const fields = roadFields[town];
    const attributes: Record<string, unknown> = { [fields.name]: name };
    if (fields.cls && roadClass) attributes[fields.cls] = roadClass;
    await addFeature(town, "road_segments", attributes, lineString(points));
  }

  /** Two streets crossing at (cx, cy), each split into two segments at the junction. */
  async function addPlus(
    cx: number,
    cy: number,
    horizontal: string,
    vertical: string,
    towns = "Milton" as Town,
    hClass = "1",
    vClass = "2",
  ) {
    await addRoad(towns, horizontal, hClass, [cx - 100, cy], [cx, cy]);
    await addRoad(towns, horizontal, hClass, [cx, cy], [cx + 100, cy]);
    await addRoad(towns, vertical, vClass, [cx, cy - 100], [cx, cy]);
    await addRoad(towns, vertical, vClass, [cx, cy], [cx, cy + 100]);
  }

  const refreshViews = async () => {
    await db.query("REFRESH MATERIALIZED VIEW open_data_sync.wards");
    await db.query("REFRESH MATERIALIZED VIEW open_data_sync.road_segments");
    await db.query("REFRESH MATERIALIZED VIEW open_data_sync.intersections");
  };
  const intersections = async () => {
    await refreshViews();
    return rows("SELECT * FROM open_data_sync.intersections ORDER BY label");
  };

  async function addIncident(
    id: string,
    x: number,
    y: number,
    extra: { city?: string | null; description?: string } = {},
  ) {
    const [lon, lat] = toLonLat(x, y);
    await db.query(
      `INSERT INTO safe_streets_halton.hrps_data
         (case_no, date, description, location, city, latitude, longitude, "globalId")
       VALUES ($1, now(), $2, 'somewhere', $3, $4, $5, $6)`,
      [
        id,
        extra.description ?? "MVC - PI",
        extra.city === undefined ? "MILTON" : extra.city,
        lat,
        lon,
        id,
      ],
    );
  }

  const location = async (id: string) => {
    const [row] = await rows(
      "SELECT * FROM open_data_sync.incident_locations WHERE global_id = $1",
      [id],
    );
    return row;
  };
  const refreshLocations = async (recomputeAll = false) =>
    Number(await scalar("SELECT open_data_sync.refresh_incident_locations($1)", [recomputeAll]));

  /** Milton wards 1 (x 0..1000) and 2 (x 1000..2000), both y 0..1000. */
  async function addMiltonWards() {
    await addWard("Milton", { WARD_NUM: 1, Name: "West" }, rectangle(0, 0, 1000, 1000));
    await addWard("Milton", { WARD_NUM: 2, Name: "East" }, rectangle(1000, 0, 2000, 1000));
  }

  it("normalize_street_name tidies suffixes, directions and parentheticals", async () => {
    const normalize = async (raw: string | null) =>
      scalar("SELECT open_data_sync.normalize_street_name($1)", [raw]);
    expect(await normalize("BRANT ST.")).toBe("Brant Street");
    expect(await normalize("Brant Rd")).toBe("Brant Road");
    expect(await normalize("MAIN STREET S")).toBe("Main Street South");
    expect(await normalize("St Georges Rd")).toBe("St Georges Road");
    expect(await normalize("BELL SCHOOL LINE ( N LEG)")).toBe("Bell School Line");
    expect(await normalize(null)).toBeNull();
    expect(await normalize("")).toBeNull();
    expect(await normalize("   ")).toBeNull();
    expect(await normalize("Highway 7")).toBe("Highway 7");
  });

  it("incident_town maps police cities to municipalities", async () => {
    const town = async (city: string | null) =>
      scalar("SELECT open_data_sync.incident_town($1)", [city]);
    expect(await town("Georgetown")).toBe("Halton Hills");
    expect(await town("Acton")).toBe("Halton Hills");
    expect(await town("HALTON HILLS")).toBe("Halton Hills");
    expect(await town("milton")).toBe("Milton");
    expect(await town("BURLINGTON")).toBe("Burlington");
    expect(await town("Campbellville")).toBe("Campbellville");
    expect(await town(null)).toBeNull();
  });

  describe("wards view", () => {
    it("builds ward_id from town and a number parsed from ints or text", async () => {
      await addWard("Milton", { WARD_NUM: 2, Name: "Central" }, rectangle(0, 0, 100, 100));
      await addWard("Halton Hills", { WARD: "Ward 3" }, rectangle(200, 0, 300, 100));
      await addWard("Burlington", { WARD_NO_INTEGER: 5 }, rectangle(400, 0, 500, 100));
      await addWard(
        "Oakville",
        { Ward: 4, FULL_NAME: "Ward 4 - Lakeshore" },
        rectangle(600, 0, 700, 100),
      );
      await refreshViews();
      const wards = await rows(
        "SELECT ward_id, town, ward_number, ward_name FROM open_data_sync.wards ORDER BY ward_id",
      );
      expect(wards).toEqual([
        { ward_id: "burlington-5", town: "Burlington", ward_number: 5, ward_name: "Ward 5" },
        { ward_id: "halton-hills-3", town: "Halton Hills", ward_number: 3, ward_name: "Ward 3" },
        { ward_id: "milton-2", town: "Milton", ward_number: 2, ward_name: "Central" },
        {
          ward_id: "oakville-4",
          town: "Oakville",
          ward_number: 4,
          ward_name: "Ward 4 - Lakeshore",
        },
      ]);
    });

    it("stores geom_m in SRID 2958 and a simplified display geometry", async () => {
      // A 1 m wiggle on the east edge that a 5 m simplification should drop.
      const [a, b, c, d, e] = [
        [0, 0],
        [1000, 0],
        [1000, 500],
        [1001, 750],
        [1000, 1000],
      ] as XY[];
      const wiggly = {
        type: "Polygon",
        coordinates: [[a!, b!, c!, d!, e!, [0, 1000], a!].map(([x, y]) => toLonLat(x, y))],
      };
      await addWard("Milton", { WARD_NUM: 1 }, wiggly);
      await refreshViews();
      const [ward] = await rows(`SELECT ST_SRID(geom_m) AS m_srid, ST_SRID(geom) AS srid,
        ST_SRID(geom_display) AS d_srid, ST_NPoints(geom) AS full_points,
        ST_NPoints(geom_display) AS display_points FROM open_data_sync.wards`);
      expect(ward).toMatchObject({ m_srid: 2958, srid: 4326, d_srid: 4326 });
      expect(Number(ward!.display_points)).toBeLessThan(Number(ward!.full_points));
    });

    it("merges several features of one ward into a single row", async () => {
      await addWard("Milton", { WARD_NUM: 2, Name: "East" }, rectangle(0, 0, 500, 500));
      await addWard("Milton", { WARD_NUM: 2, Name: "East" }, rectangle(500, 0, 1000, 500));
      await refreshViews();
      const wards = await rows("SELECT ward_id, ST_Area(geom_m) AS area FROM open_data_sync.wards");
      expect(wards).toHaveLength(1);
      expect(Number(wards[0]!.area)).toBeGreaterThan(240_000);
    });
  });

  describe("intersections view", () => {
    it("finds a crossing of two streets and orders names by class rank, then name", async () => {
      await addPlus(0, 0, "MAIN ST", "ELM ST", "Milton", "1", "3");
      const found = await intersections();
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        label: "Main Street & Elm Street",
        street_names: ["Main Street", "Elm Street"],
        town: "Milton",
      });
    });

    it("breaks class ties by name", async () => {
      await addPlus(0, 0, "MAIN ST", "ELM ST", "Milton", "2", "2");
      const found = await intersections();
      expect(found.map((row) => row.label)).toEqual(["Elm Street & Main Street"]);
    });

    it("ignores a street split into two segments of the same name", async () => {
      await addRoad("Milton", "MAIN ST", "2", [-100, 0], [0, 0]);
      await addRoad("Milton", "MAIN ST", "2", [0, 0], [100, 0]);
      expect(await intersections()).toHaveLength(0);
    });

    it("ignores dead ends", async () => {
      await addRoad("Milton", "MAIN ST", "2", [-100, 0], [0, 0]);
      await addRoad("Milton", "MAIN ST", "2", [0, 0], [100, 0]);
      await addRoad("Milton", "ELM ST", "3", [0, 10], [0, 100]);
      expect(await intersections()).toHaveLength(0);
    });

    it("ignores an overpass where lines cross without a shared end point", async () => {
      await addRoad("Milton", "MAIN ST", "2", [-100, 0], [100, 0]);
      await addRoad("Milton", "HIGHWAY 401", "1", [0, -100], [0, 100]);
      expect(await intersections()).toHaveLength(0);
    });

    it("merges the two carriageways of a divided road into one intersection", async () => {
      await addRoad("Milton", "MAIN ST", "2", [-100, 5], [0, 5]);
      await addRoad("Milton", "MAIN ST", "2", [0, 5], [100, 5]);
      await addRoad("Milton", "MAIN ST", "2", [-100, -5], [0, -5]);
      await addRoad("Milton", "MAIN ST", "2", [0, -5], [100, -5]);
      await addRoad("Milton", "ELM ST", "3", [0, -100], [0, -5]);
      await addRoad("Milton", "ELM ST", "3", [0, -5], [0, 5]);
      await addRoad("Milton", "ELM ST", "3", [0, 5], [0, 100]);
      const found = await intersections();
      expect(found).toHaveLength(1);
      expect(found[0]!.label).toBe("Main Street & Elm Street");
    });

    it("merges a boundary road published by two towns", async () => {
      // Milton's copy meets Dundas at x = 0, Oakville's copy 10 m east of it.
      await addRoad("Milton", "TRAFALGAR RD", "1", [0, -100], [0, 0]);
      await addRoad("Milton", "TRAFALGAR RD", "1", [0, 0], [0, 100]);
      await addRoad("Milton", "DUNDAS ST", "2", [-100, 0], [0, 0]);
      await addRoad("Oakville", "Trafalgar Road", "1", [10, -100], [10, 0]);
      await addRoad("Oakville", "Trafalgar Road", "1", [10, 0], [10, 100]);
      await addRoad("Oakville", "Dundas Street", "2", [10, 0], [110, 0]);
      const found = await intersections();
      expect(found).toHaveLength(1);
      expect(found[0]!.label).toBe("Trafalgar Road & Dundas Street");
    });

    it("keeps intersection_id stable across a refresh and 16 characters long", async () => {
      await addPlus(0, 0, "MAIN ST", "ELM ST");
      const first = await intersections();
      const second = await intersections();
      expect(String(first[0]!.intersection_id)).toHaveLength(16);
      expect(second[0]!.intersection_id).toBe(first[0]!.intersection_id);
    });

    it("lists three streets meeting at one point", async () => {
      await addPlus(0, 0, "MAIN ST", "ELM ST", "Milton", "1", "2");
      await addRoad("Milton", "OAK ST", "3", [50, 50], [0, 0]);
      const found = await intersections();
      expect(found).toHaveLength(1);
      expect(found[0]!.label).toBe("Main Street & Elm Street & Oak Street");
    });
  });

  describe("incident locations", () => {
    it("assigns the covering ward, and the lower ward_id on a shared boundary", async () => {
      await addMiltonWards();
      await refreshViews();
      await addIncident("in-west", 500, 500);
      await addIncident("in-east", 1500, 500);
      // The shared corner is a vertex of both polygons, so both cover it.
      await addIncident("corner", 1000, 0);
      await refreshLocations();
      expect((await location("in-west"))!.ward_id).toBe("milton-1");
      expect((await location("in-east"))!.ward_id).toBe("milton-2");
      expect((await location("corner"))!.ward_id).toBe("milton-1");
    });

    it("gives a point just outside the nearest ward within 50 m, and none beyond", async () => {
      await addMiltonWards();
      await refreshViews();
      await addIncident("near", -20, 500);
      await addIncident("far", -200, 500);
      await refreshLocations();
      expect((await location("near"))!.ward_id).toBe("milton-1");
      expect((await location("far"))!.ward_id).toBeNull();
      expect((await location("far"))!.ward_town).toBeNull();
    });

    it("assigns an intersection only within 30 m and records the distance", async () => {
      await addPlus(500, 500, "MAIN ST", "ELM ST");
      await refreshViews();
      await addIncident("close", 510, 500);
      await addIncident("distant", 540, 500);
      await refreshLocations();
      const close = (await location("close"))!;
      expect(close.intersection_id).not.toBeNull();
      expect(Number(close.distance_to_intersection_m)).toBeCloseTo(10, 0);
      const distant = (await location("distant"))!;
      expect(distant.intersection_id).toBeNull();
      expect(distant.distance_to_intersection_m).toBeNull();
    });

    it("picks the nearest intersection when two are within range", async () => {
      await addRoad("Milton", "MAIN ST", "1", [400, 500], [500, 500]);
      await addRoad("Milton", "MAIN ST", "1", [500, 500], [540, 500]);
      await addRoad("Milton", "MAIN ST", "1", [540, 500], [640, 500]);
      await addRoad("Milton", "ELM ST", "2", [500, 400], [500, 500]);
      await addRoad("Milton", "ELM ST", "2", [500, 500], [500, 600]);
      await addRoad("Milton", "OAK ST", "2", [540, 400], [540, 500]);
      await addRoad("Milton", "OAK ST", "2", [540, 500], [540, 600]);
      await refreshViews();
      const all = await rows(
        "SELECT intersection_id, label FROM open_data_sync.intersections ORDER BY ST_X(geom_m)",
      );
      expect(all).toHaveLength(2);
      await addIncident("between", 525, 500);
      await refreshLocations();
      const picked = (await location("between"))!;
      expect(picked.intersection_id).toBe(all[1]!.intersection_id);
      expect(Number(picked.distance_to_intersection_m)).toBeCloseTo(15, 0);
    });

    it("records a ward_town that differs from the incident town", async () => {
      await addMiltonWards();
      await refreshViews();
      await addIncident("cross-border", 500, 500, { city: "OAKVILLE" });
      await refreshLocations();
      expect(await location("cross-border")).toMatchObject({
        town: "Oakville",
        ward_town: "Milton",
      });
    });

    it("maps Georgetown to Halton Hills", async () => {
      await addIncident("gt", 500, 500, { city: "Georgetown" });
      await refreshLocations();
      expect((await location("gt"))!.town).toBe("Halton Hills");
    });

    it("works incrementally: unchanged rows are skipped, changed, new and deleted ones follow", async () => {
      await addMiltonWards();
      await refreshViews();
      await addIncident("a", 100, 100);
      await addIncident("b", 200, 200);
      await addIncident("c", 300, 300);
      expect(await refreshLocations()).toBe(3);
      expect(await refreshLocations()).toBe(0);

      await db.query(
        `UPDATE safe_streets_halton.hrps_data SET updated_at = updated_at + interval '1 hour' WHERE "globalId" = 'b'`,
      );
      expect(await refreshLocations()).toBe(1);
      expect(await refreshLocations()).toBe(0);

      await addIncident("d", 400, 400);
      expect(await refreshLocations()).toBe(1);

      await db.query(`DELETE FROM safe_streets_halton.hrps_data WHERE "globalId" = 'a'`);
      expect(await refreshLocations()).toBe(0);
      expect(await location("a")).toBeUndefined();
      expect(Number(await scalar("SELECT count(*) FROM open_data_sync.incident_locations"))).toBe(
        3,
      );

      expect(await refreshLocations(true)).toBe(3);
    });
  });

  describe("integration_qa", () => {
    it("reports counts for incidents, wards, intersections and unknown descriptions", async () => {
      await addMiltonWards();
      await addPlus(500, 500, "MAIN ST", "ELM ST");
      await refreshViews();
      await addIncident("near-pi", 505, 500);
      await addIncident("padded", 500, 505, { description: " MVC - PI", city: "OAKVILLE" });
      await addIncident("offshore", -500, 500, { description: "mvc - fatality" });
      await addIncident("unknown-1", 800, 800, { description: "SPEEDING TICKET" });
      await addIncident("unknown-2", 900, 800, { description: "Impaired Driving" });
      // Latitude outside the valid range: never located.
      await db.query(
        `INSERT INTO safe_streets_halton.hrps_data (case_no, date, description, city, latitude, longitude, "globalId")
         VALUES ('bad', now(), 'MVC - PI', 'MILTON', 95, -79.8, 'bad')`,
      );

      const qa = async () => (await rows("SELECT * FROM open_data_sync.integration_qa"))[0]!;
      expect(Number((await qa()).incidents_unlocated)).toBe(6);

      await refreshLocations();
      const result = await qa();
      expect(Number(result.incidents_total)).toBe(6);
      expect(Number(result.incidents_unlocated)).toBe(1);
      expect(Number(result.incidents_without_ward)).toBe(1);
      expect(Number(result.ward_town_mismatches)).toBe(1);
      expect(Number(result.share_near_intersection)).toBeCloseTo(0.4, 4);
      expect(result.intersections_per_town).toEqual({ Milton: 1 });
      expect(Number(result.unknown_description_incidents)).toBe(2);
      expect(result.unknown_descriptions).toEqual(["SPEEDING TICKET"]);
    });
  });

  it("layer_field_map matches FIELD_MAP exactly", async () => {
    const fromDatabase = await rows(
      `SELECT town, data_group, ward_number_field, ward_name_field, street_name_field, road_class_field
       FROM open_data_sync.layer_field_map ORDER BY town, data_group`,
    );
    const fromCode = FIELD_MAP.map((entry) => ({
      town: entry.town,
      data_group: entry.dataGroup,
      ward_number_field: entry.wardNumberField ?? null,
      ward_name_field: entry.wardNameField ?? null,
      street_name_field: entry.streetNameField ?? null,
      road_class_field: entry.roadClassField ?? null,
    })).sort((a, b) => a.town.localeCompare(b.town) || a.data_group.localeCompare(b.data_group));
    expect(fromDatabase).toEqual(fromCode);
  });
});
