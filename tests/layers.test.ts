import { describe, expect, it } from "vite-plus/test";
import { DATA_GROUPS, LAYERS, TODO_URL, TOWNS } from "../src/layers";

describe("layer config", () => {
  it("has 9 layers", () => {
    expect(LAYERS).toHaveLength(9);
  });

  it("has unique URLs (TODO placeholders excepted)", () => {
    const urls = LAYERS.map((l) => l.url).filter((u) => u !== TODO_URL);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("uses valid towns and data groups", () => {
    for (const l of LAYERS) {
      expect(TOWNS).toContain(l.town);
      expect(DATA_GROUPS).toContain(l.dataGroup);
    }
  });

  it("has resolved URLs ending in a layer index", () => {
    for (const l of LAYERS.filter((x) => x.url !== TODO_URL)) {
      expect(l.url).toMatch(/\/(MapServer|FeatureServer)\/\d+$/);
    }
  });
});
