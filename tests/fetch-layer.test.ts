import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fetchLayerFeatures } from "../src/fetch-layer";

const layerUrl = "https://gis.example.test/arcgis/rest/services/Roads/MapServer/3";

type Responder = (url: URL) => unknown;

/**
 * Stand-in ArcGIS server. The Esri client always calls the global `fetch`, so the
 * tests replace that and record every URL it is asked for.
 */
function fakeServer(respond: Responder) {
  const requested: URL[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    requested.push(url);
    const body = respond(url);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const featureQueries = () =>
    requested.filter(
      (url) => url.pathname.endsWith("/query") && url.searchParams.has("resultOffset"),
    );
  return { requested, featureQueries };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const isQuery = (url: URL) => url.pathname.endsWith("/query");
const isCountQuery = (url: URL) => url.searchParams.get("returnCountOnly") === "true";

const point = (x: number) => ({ type: "Point", coordinates: [x, 0] });
const feature = (id: number | undefined, properties: Record<string, unknown> = {}) => ({
  type: "Feature",
  id,
  properties,
  geometry: point(id ?? 0),
});

type FlagPlacement = "top-level" | "properties" | "both" | "none";

/** Serves metadata, a feature count, and pages of the given features. */
function pagedLayer(
  pages: unknown[][],
  { metadata = { maxRecordCount: 2 }, flag = "top-level" as FlagPlacement } = {},
) {
  const total = pages.reduce((sum, page) => sum + page.length, 0);
  return fakeServer((url) => {
    if (!isQuery(url)) return metadata;
    if (isCountQuery(url)) return { count: total };
    const offset = Number(url.searchParams.get("resultOffset") ?? 0);
    const size = Number(url.searchParams.get("resultRecordCount"));
    const pageIndex = Math.floor(offset / size);
    const more = pageIndex < pages.length - 1;
    return {
      type: "FeatureCollection",
      features: pages[pageIndex] ?? [],
      ...(more && (flag === "top-level" || flag === "both") ? { exceededTransferLimit: true } : {}),
      ...(more && (flag === "properties" || flag === "both")
        ? { properties: { exceededTransferLimit: true } }
        : {}),
    };
  });
}

const ids = (result: { features: { sourceFeatureId: string }[] }) =>
  result.features.map((f) => f.sourceFeatureId);

describe("fetchLayerFeatures", () => {
  it("requests GeoJSON in WGS84 for every feature of the layer", async () => {
    const { featureQueries } = pagedLayer([[feature(1)]]);
    await fetchLayerFeatures(layerUrl);
    const query = featureQueries()[0]!;
    expect(query.origin + query.pathname).toBe(`${layerUrl}/query`);
    expect(Object.fromEntries(query.searchParams)).toMatchObject({
      where: "1=1",
      outFields: "*",
      outSR: "4326",
      f: "geojson",
    });
  });

  it("keeps requesting pages while the server reports more data", async () => {
    const { featureQueries } = pagedLayer([
      [feature(1), feature(2)],
      [feature(3), feature(4)],
      [feature(5)],
    ]);
    const result = await fetchLayerFeatures(layerUrl);
    expect(ids(result)).toEqual(["1", "2", "3", "4", "5"]);
    expect(featureQueries().map((url) => url.searchParams.get("resultOffset"))).toEqual([
      "0",
      "2",
      "4",
    ]);
  });

  it.each([1000, 2000, 9999])(
    "uses the layer's maxRecordCount (%i) as the page size",
    async (size) => {
      const { featureQueries } = pagedLayer([[feature(1)]], { metadata: { maxRecordCount: size } });
      await fetchLayerFeatures(layerUrl);
      expect(featureQueries()[0]!.searchParams.get("resultRecordCount")).toBe(String(size));
    },
  );

  it("fails when the layer metadata request returns an error", async () => {
    fakeServer((url) =>
      isQuery(url) ? { features: [] } : { error: { code: 400, message: "Invalid URL" } },
    );
    await expect(fetchLayerFeatures(layerUrl)).rejects.toThrow(/Invalid URL/);
  });

  it("stops on an empty page even if the server still claims more", async () => {
    fakeServer((url) => {
      if (!isQuery(url)) return { maxRecordCount: 2 };
      if (isCountQuery(url)) return { count: 0 };
      return { type: "FeatureCollection", features: [], exceededTransferLimit: true };
    });
    const result = await fetchLayerFeatures(layerUrl);
    expect(result.features).toEqual([]);
  });

  it("treats an HTTP 200 response with an error body as a failure", async () => {
    fakeServer((url) =>
      isQuery(url)
        ? { error: { code: 500, message: "Unable to complete operation." } }
        : { maxRecordCount: 2 },
    );
    await expect(fetchLayerFeatures(layerUrl)).rejects.toThrow(/Unable to complete operation/);
  });

  it("fails on a non-OK HTTP status", async () => {
    fakeServer((url) =>
      isQuery(url) ? new Response("nope", { status: 503 }) : { maxRecordCount: 2 },
    );
    await expect(fetchLayerFeatures(layerUrl)).rejects.toThrow(/503/);
  });

  it("fails rather than returning a partial result when a later page errors", async () => {
    fakeServer((url) => {
      if (!isQuery(url)) return { maxRecordCount: 1 };
      if (isCountQuery(url)) return { count: 2 };
      return url.searchParams.get("resultOffset") === "0"
        ? { features: [feature(1)], exceededTransferLimit: true }
        : { error: { code: 500, message: "boom" } };
    });
    await expect(fetchLayerFeatures(layerUrl)).rejects.toThrow(/boom/);
  });

  describe("where servers put exceededTransferLimit", () => {
    const pages = [[feature(1), feature(2)], [feature(3), feature(4)], [feature(5)]];

    it.each(["top-level", "properties", "both"] as const)(
      "keeps paging when the flag is %s",
      async (flag) => {
        pagedLayer(pages, { flag });
        expect(ids(await fetchLayerFeatures(layerUrl))).toEqual(["1", "2", "3", "4", "5"]);
      },
    );

    it("fails instead of silently truncating when no flag is present but the feature count says more exist", async () => {
      pagedLayer(pages, { flag: "none" });
      await expect(fetchLayerFeatures(layerUrl)).rejects.toThrow(/5 features.*only 2/);
    });

    it("accepts a full final page when no flag is present and the count matches", async () => {
      pagedLayer([[feature(1), feature(2)]], { flag: "none" });
      expect(ids(await fetchLayerFeatures(layerUrl))).toEqual(["1", "2"]);
    });
  });

  describe("feature ids", () => {
    it.each([
      ["feature.id", feature(7), "7"],
      ["OBJECTID", feature(undefined, { OBJECTID: 12 }), "12"],
      ["objectid", feature(undefined, { objectid: 13 }), "13"],
      ["FID", feature(undefined, { FID: "abc" }), "abc"],
    ])("reads the id from %s", async (_source, input, expected) => {
      pagedLayer([[input]]);
      expect(ids(await fetchLayerFeatures(layerUrl))).toEqual([expected]);
    });

    it("prefers feature.id over properties", async () => {
      pagedLayer([[feature(1, { OBJECTID: 99 })]]);
      const result = await fetchLayerFeatures(layerUrl);
      expect(result.features[0]!.sourceFeatureId).toBe("1");
    });

    it("skips and counts features with no usable id, keeping the rest", async () => {
      pagedLayer([
        [feature(1), feature(undefined, { NAME: "no id" }), feature(undefined, { OBJECTID: null })],
      ]);
      const result = await fetchLayerFeatures(layerUrl);
      expect(ids(result)).toEqual(["1"]);
      expect(result.skippedWithoutId).toBe(2);
    });

    it("keeps one feature per id when paging returns a duplicate", async () => {
      pagedLayer([[feature(1), feature(2)], [feature(2)]]);
      expect(ids(await fetchLayerFeatures(layerUrl))).toEqual(["1", "2"]);
    });
  });

  it("carries attributes and geometry, allowing a null geometry", async () => {
    pagedLayer([
      [
        { type: "Feature", id: 1, properties: { NAME: "Main St" }, geometry: point(5) },
        { type: "Feature", id: 2, properties: {}, geometry: null },
      ],
    ]);
    const { features } = await fetchLayerFeatures(layerUrl);
    expect(features[0]).toEqual({
      sourceFeatureId: "1",
      attributes: { NAME: "Main St" },
      geometry: point(5),
    });
    expect(features[1]!.geometry).toBeNull();
  });
});
