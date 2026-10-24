import { describe, expect, it } from "vite-plus/test";
import { FIELD_MAP } from "../src/field-map";
import { LAYERS } from "../src/layers";

describe("FIELD_MAP", () => {
  it("covers every ward_boundaries and road_segments layer in LAYERS", () => {
    const needed = LAYERS.filter(
      (layer) => layer.dataGroup === "ward_boundaries" || layer.dataGroup === "road_segments",
    ).map((layer) => `${layer.town}/${layer.dataGroup}`);
    const mapped = FIELD_MAP.map((entry) => `${entry.town}/${entry.dataGroup}`);
    expect(needed.length).toBeGreaterThan(0);
    expect(mapped).toEqual(expect.arrayContaining(needed));
  });

  it("has one entry per town and data group", () => {
    const keys = FIELD_MAP.map((entry) => `${entry.town}/${entry.dataGroup}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
