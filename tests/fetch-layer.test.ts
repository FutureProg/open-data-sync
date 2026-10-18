import { describe, expect, it } from "vite-plus/test";
import { fetchLayerFeatures } from "../src/fetch-layer";

const layerUrl = "https://gis.example.test/arcgis/rest/services/Roads/MapServer/3";

type Responder = (url: URL) => unknown;

/** A fetch that answers from `respond` and records every requested URL. */
function fakeFetch(respond: Responder) {
  const requested: URL[] = [];
  const fetchFunction: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    requested.push(url);
    const body = respond(url);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fetchFunction, requested };
}

const point = (x: number) => ({ type: "Point", coordinates: [x, 0] });
const feature = (id: number | undefined, properties: Record<string, unknown> = {}) => ({
  type: "Feature",
  id,
  properties,
  geometry: point(id ?? 0),
});

/** Serves `maxRecordCount` metadata, then feature pages of the given sizes. */
function pagedLayer(pages: unknown[][], metadata: unknown = { maxRecordCount: 2 }) {
  return fakeFetch((url) => {
    if (url.pathname.endsWith("/query")) {
      const offset = Number(url.searchParams.get("resultOffset") ?? 0);
      const size = Number(url.searchParams.get("resultRecordCount"));
      const pageIndex = Math.floor(offset / size);
      const features = pages[pageIndex] ?? [];
      return {
        type: "FeatureCollection",
        features,
        ...(pageIndex < pages.length - 1 ? { exceededTransferLimit: true } : {}),
      };
    }
    return metadata;
  });
}

describe("fetchLayerFeatures", () => {
  it("requests GeoJSON in WGS84 for every feature of the layer", async () => {
    const { fetchFunction, requested } = pagedLayer([[feature(1)]]);
    await fetchLayerFeatures(layerUrl, { fetchFunction });
    const query = requested.find((url) => url.pathname.endsWith("/query"))!;
    expect(query.origin + query.pathname).toBe(`${layerUrl}/query`);
    expect(Object.fromEntries(query.searchParams)).toMatchObject({
      where: "1=1",
      outFields: "*",
      outSR: "4326",
      f: "geojson",
    });
  });

  it("keeps requesting pages while the server reports exceededTransferLimit", async () => {
    const { fetchFunction, requested } = pagedLayer([
      [feature(1), feature(2)],
      [feature(3), feature(4)],
      [feature(5)],
    ]);
    // The last page above still carries no exceededTransferLimit, so it ends the loop.
    const result = await fetchLayerFeatures(layerUrl, { fetchFunction });
    expect(result.features.map((f) => f.sourceFeatureId)).toEqual(["1", "2", "3", "4", "5"]);
    const offsets = requested
      .filter((url) => url.pathname.endsWith("/query"))
      .map((url) => url.searchParams.get("resultOffset"));
    expect(offsets).toEqual(["0", "2", "4"]);
  });

  describe("paging without a top-level exceededTransferLimit", () => {
    /** Serves pages of size 2, putting the "more data" flag where `placeFlag` says (or nowhere). */
    function layerWithFlag(placeFlag: ((more: boolean) => object) | undefined) {
      const pages = [[feature(1), feature(2)], [feature(3), feature(4)], [feature(5)]];
      return fakeFetch((url) => {
        if (!url.pathname.endsWith("/query")) return { maxRecordCount: 2 };
        const index = Number(url.searchParams.get("resultOffset")) / 2;
        const more = index < pages.length - 1;
        return {
          type: "FeatureCollection",
          features: pages[index] ?? [],
          ...placeFlag?.(more),
        };
      });
    }
    const ids = (result: { features: { sourceFeatureId: string }[] }) =>
      result.features.map((f) => f.sourceFeatureId);

    it("keeps paging when the flag is only inside top-level properties", async () => {
      const { fetchFunction } = layerWithFlag((more) => ({
        properties: { exceededTransferLimit: more },
      }));
      expect(ids(await fetchLayerFeatures(layerUrl, { fetchFunction }))).toEqual([
        "1",
        "2",
        "3",
        "4",
        "5",
      ]);
    });

    it("keeps paging when the flag is at the top level", async () => {
      const { fetchFunction } = layerWithFlag((more) => ({ exceededTransferLimit: more }));
      expect(ids(await fetchLayerFeatures(layerUrl, { fetchFunction }))).toHaveLength(5);
    });

    it("keeps paging after a full page even when no flag is present anywhere", async () => {
      const { fetchFunction } = layerWithFlag(undefined);
      expect(ids(await fetchLayerFeatures(layerUrl, { fetchFunction }))).toHaveLength(5);
    });

    it("stops after a full page followed by an empty page when no flag is present", async () => {
      const { fetchFunction, requested } = fakeFetch((url) =>
        url.pathname.endsWith("/query")
          ? {
              features:
                url.searchParams.get("resultOffset") === "0" ? [feature(1), feature(2)] : [],
            }
          : { maxRecordCount: 2 },
      );
      const result = await fetchLayerFeatures(layerUrl, { fetchFunction });
      expect(result.features).toHaveLength(2);
      expect(requested.filter((url) => url.pathname.endsWith("/query"))).toHaveLength(2);
    });
  });

  it("uses the layer's maxRecordCount as the page size", async () => {
    const { fetchFunction, requested } = pagedLayer([[feature(1)]], { maxRecordCount: 250 });
    await fetchLayerFeatures(layerUrl, { fetchFunction });
    const query = requested.find((url) => url.pathname.endsWith("/query"))!;
    expect(query.searchParams.get("resultRecordCount")).toBe("250");
  });

  it("falls back to a default page size when metadata cannot be read", async () => {
    const { fetchFunction, requested } = pagedLayer([[feature(1)]], { error: { code: 400 } });
    await fetchLayerFeatures(layerUrl, { fetchFunction });
    const size = requested
      .find((url) => url.pathname.endsWith("/query"))!
      .searchParams.get("resultRecordCount");
    expect(Number(size)).toBeGreaterThan(0);
  });

  it("stops on an empty page even if the server still claims more", async () => {
    const { fetchFunction } = fakeFetch((url) =>
      url.pathname.endsWith("/query")
        ? { type: "FeatureCollection", features: [], exceededTransferLimit: true }
        : { maxRecordCount: 2 },
    );
    const result = await fetchLayerFeatures(layerUrl, { fetchFunction });
    expect(result.features).toEqual([]);
  });

  it("treats an HTTP 200 response with an error body as a failure", async () => {
    const { fetchFunction } = fakeFetch((url) =>
      url.pathname.endsWith("/query")
        ? { error: { code: 500, message: "Unable to complete operation." } }
        : { maxRecordCount: 2 },
    );
    await expect(fetchLayerFeatures(layerUrl, { fetchFunction })).rejects.toThrow(
      /500.*Unable to complete operation/,
    );
  });

  it("fails on a non-OK HTTP status", async () => {
    const { fetchFunction } = fakeFetch((url) =>
      url.pathname.endsWith("/query") ? new Response("nope", { status: 503 }) : {},
    );
    await expect(fetchLayerFeatures(layerUrl, { fetchFunction })).rejects.toThrow(/503/);
  });

  it("fails rather than returning a partial result when a later page errors", async () => {
    const { fetchFunction } = fakeFetch((url) => {
      if (!url.pathname.endsWith("/query")) return { maxRecordCount: 1 };
      return url.searchParams.get("resultOffset") === "0"
        ? { features: [feature(1)], exceededTransferLimit: true }
        : { error: { code: 500, message: "boom" } };
    });
    await expect(fetchLayerFeatures(layerUrl, { fetchFunction })).rejects.toThrow(/boom/);
  });

  describe("feature ids", () => {
    it.each([
      ["feature.id", feature(7), "7"],
      ["OBJECTID", feature(undefined, { OBJECTID: 12 }), "12"],
      ["objectid", feature(undefined, { objectid: 13 }), "13"],
      ["FID", feature(undefined, { FID: "abc" }), "abc"],
    ])("reads the id from %s", async (_source, input, expected) => {
      const { fetchFunction } = pagedLayer([[input]]);
      const result = await fetchLayerFeatures(layerUrl, { fetchFunction });
      expect(result.features.map((f) => f.sourceFeatureId)).toEqual([expected]);
    });

    it("prefers feature.id over properties", async () => {
      const { fetchFunction } = pagedLayer([[feature(1, { OBJECTID: 99 })]]);
      const result = await fetchLayerFeatures(layerUrl, { fetchFunction });
      expect(result.features[0]!.sourceFeatureId).toBe("1");
    });

    it("skips and counts features with no usable id, keeping the rest", async () => {
      const { fetchFunction } = pagedLayer([
        [feature(1), feature(undefined, { NAME: "no id" }), feature(undefined, { OBJECTID: null })],
      ]);
      const result = await fetchLayerFeatures(layerUrl, { fetchFunction });
      expect(result.features.map((f) => f.sourceFeatureId)).toEqual(["1"]);
      expect(result.skippedWithoutId).toBe(2);
    });

    it("keeps one feature per id when paging returns a duplicate", async () => {
      const { fetchFunction } = pagedLayer([[feature(1), feature(2)], [feature(2)]]);
      const result = await fetchLayerFeatures(layerUrl, { fetchFunction });
      expect(result.features.map((f) => f.sourceFeatureId)).toEqual(["1", "2"]);
    });
  });

  it("carries attributes and geometry, allowing a null geometry", async () => {
    const { fetchFunction } = pagedLayer([
      [
        { type: "Feature", id: 1, properties: { NAME: "Main St" }, geometry: point(5) },
        { type: "Feature", id: 2, properties: {}, geometry: null },
      ],
    ]);
    const { features } = await fetchLayerFeatures(layerUrl, { fetchFunction });
    expect(features[0]).toEqual({
      sourceFeatureId: "1",
      attributes: { NAME: "Main St" },
      geometry: point(5),
    });
    expect(features[1]!.geometry).toBeNull();
  });
});
