import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fetchSourceFingerprint, planLayerSync, type SourceFingerprint } from "../src/fingerprint";

const layerUrl = "https://gis.example.test/arcgis/rest/services/Roads/MapServer/3";

/** Stand-in ArcGIS server; the Esri client always calls the global `fetch`. */
function fakeServer(respond: (url: URL) => unknown) {
  const requested: URL[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    requested.push(url);
    const body = respond(url);
    return body instanceof Response ? body : Response.json(body);
  });
  return { requested };
}

/** Answers like a real statistics query: one row holding the aggregated values. */
const statisticsAnswer = (featureCount: number, latestEditMilliseconds: number | null) => ({
  features: [{ attributes: { feature_count: featureCount, latest_edit: latestEditMilliseconds } }],
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchSourceFingerprint", () => {
  it("asks the layer for the feature count and latest edit date in one statistics query", async () => {
    const { requested } = fakeServer(() => statisticsAnswer(10, 1_700_000_000_000));
    await fetchSourceFingerprint(layerUrl, "LAST_EDITED_DATE");

    expect(requested).toHaveLength(1);
    const query = requested[0]!;
    expect(query.origin + query.pathname).toBe(`${layerUrl}/query`);
    expect(query.searchParams.get("where")).toBe("1=1");
    expect(query.searchParams.get("returnGeometry")).toBe("false");
    const statistics = JSON.parse(query.searchParams.get("outStatistics")!);
    expect(statistics).toEqual([
      {
        statisticType: "count",
        onStatisticField: "LAST_EDITED_DATE",
        outStatisticFieldName: "feature_count",
      },
      {
        statisticType: "max",
        onStatisticField: "LAST_EDITED_DATE",
        outStatisticFieldName: "latest_edit",
      },
    ]);
  });

  it("returns the count and the latest edit as a date", async () => {
    fakeServer(() => statisticsAnswer(10, Date.UTC(2026, 8, 30, 14, 5, 0)));
    expect(await fetchSourceFingerprint(layerUrl, "EDIT_DATE")).toEqual({
      featureCount: 10,
      lastEditedAt: new Date("2026-09-30T14:05:00.000Z"),
    });
  });

  it("accepts an empty layer, whose latest edit is null", async () => {
    fakeServer(() => statisticsAnswer(0, null));
    expect(await fetchSourceFingerprint(layerUrl, "EDIT_DATE")).toEqual({
      featureCount: 0,
      lastEditedAt: null,
    });
  });

  it("reads statistics whose field names come back in another letter case", async () => {
    fakeServer(() => ({
      features: [{ attributes: { FEATURE_COUNT: 3, LATEST_EDIT: 1_700_000_000_000 } }],
    }));
    expect(await fetchSourceFingerprint(layerUrl, "EDIT_DATE")).toEqual({
      featureCount: 3,
      lastEditedAt: new Date(1_700_000_000_000),
    });
  });

  it.each([
    ["an error body", { error: { code: 400, message: "Unsupported operation" } }],
    ["a server error", new Response("down", { status: 503 })],
    ["no statistics row", { features: [] }],
    ["a count that is not a number", statisticsAnswer("many" as unknown as number, 1)],
    ["features but no edit dates at all", statisticsAnswer(5, null)],
  ])("rejects %s", async (_label, answer) => {
    fakeServer(() => answer);
    await expect(fetchSourceFingerprint(layerUrl, "EDIT_DATE")).rejects.toThrow();
  });
});

describe("planLayerSync", () => {
  const edited = new Date("2026-09-30T14:05:00.000Z");
  const synced = new Date("2026-10-11T06:00:00.000Z");
  const unchanged: SourceFingerprint = { featureCount: 10, lastEditedAt: edited };
  const plan = (
    stored: { fingerprint: typeof unchanged | null; lastSyncedAt: Date | null },
    log: (message: string) => void = () => {},
  ) =>
    planLayerSync({
      layerName: "Burlington road segments",
      layerUrl,
      editDateField: "LAST_EDITED_DATE",
      stored,
      log,
    });

  it("skips when the source matches the stored fingerprint, saying when it was last edited and synced", async () => {
    fakeServer(() => statisticsAnswer(10, edited.getTime()));
    const decision = await plan({ fingerprint: unchanged, lastSyncedAt: synced });
    expect(decision).toEqual({
      action: "skip",
      message:
        "Skipped Burlington road segments: unchanged, source last edited " +
        "2026-09-30T14:05:00.000Z, last synced 2026-10-11T06:00:00.000Z",
    });
  });

  it("fetches and returns the new fingerprint when the latest edit moved", async () => {
    fakeServer(() => statisticsAnswer(10, edited.getTime() + 1000));
    expect(await plan({ fingerprint: unchanged, lastSyncedAt: synced })).toEqual({
      action: "fetch",
      fingerprint: { featureCount: 10, lastEditedAt: new Date(edited.getTime() + 1000) },
    });
  });

  it("fetches when the feature count differs even though the latest edit is the same", async () => {
    fakeServer(() => statisticsAnswer(9, edited.getTime()));
    const decision = await plan({ fingerprint: unchanged, lastSyncedAt: synced });
    expect(decision.action).toBe("fetch");
  });

  it("fetches when nothing is stored yet, and keeps the fingerprint to store", async () => {
    fakeServer(() => statisticsAnswer(10, edited.getTime()));
    expect(await plan({ fingerprint: null, lastSyncedAt: null })).toEqual({
      action: "fetch",
      fingerprint: unchanged,
    });
  });

  it("skips an empty layer that was already synced empty", async () => {
    fakeServer(() => statisticsAnswer(0, null));
    const decision = await plan({
      fingerprint: { featureCount: 0, lastEditedAt: null },
      lastSyncedAt: synced,
    });
    expect(decision.action).toBe("skip");
  });

  it("logs the failure and falls back to a full fetch with no fingerprint to store", async () => {
    fakeServer(() => ({ error: { code: 400, message: "Unsupported operation" } }));
    const logged: string[] = [];
    const decision = await plan({ fingerprint: unchanged, lastSyncedAt: synced }, (message) =>
      logged.push(message),
    );
    expect(decision).toEqual({ action: "fetch", fingerprint: null });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("Burlington road segments");
    expect(logged[0]).toContain("Unsupported operation");
  });
});
