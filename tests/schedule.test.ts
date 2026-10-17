import { describe, expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { syncAllLayers } from "../src/sync";

// Void requires `cron` to be a string literal, so read it from the source text.
const source = readFileSync(new URL("../crons/sync-arcgis-layers.ts", import.meta.url), "utf8");
const SYNC_CRON = /export const cron = "([^"]+)"/.exec(source)?.[1] ?? "";

describe("schedule", () => {
  it("is weekly (fixed minute, hour and weekday; any day of month and month)", () => {
    const [min, hour, dom, month, dow] = SYNC_CRON.split(" ");
    expect(SYNC_CRON.split(" ")).toHaveLength(5);
    expect(min).toMatch(/^\d+$/);
    expect(hour).toMatch(/^\d+$/);
    expect(dom).toBe("*");
    expect(month).toBe("*");
    expect(dow).toMatch(/^[0-6]$/);
  });
});

describe("stubs", () => {
  it("syncAllLayers is not implemented yet", async () => {
    await expect(syncAllLayers({} as never)).rejects.toThrow("Not implemented");
  });
});
