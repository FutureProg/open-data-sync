import { describe, expect, it } from "vite-plus/test";
import { syncAllLayers } from "../src/sync";

describe("stubs", () => {
  it("syncAllLayers is not implemented yet", async () => {
    await expect(syncAllLayers({} as never)).rejects.toThrow("Not implemented");
  });
});
