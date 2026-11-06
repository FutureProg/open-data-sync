import { describe, expect, it, vi } from "vite-plus/test";

const syncArcgisLayers = vi.fn(async () => {});
const refreshIncidentLocationsJob = vi.fn(async () => {});
vi.mock("../src/jobs", () => ({ syncArcgisLayers, refreshIncidentLocationsJob }));

const { default: worker } = await import("../src/worker");
const { REFRESH_INCIDENT_LOCATIONS, SYNC_ARCGIS_LAYERS } = await import("../src/schedules");

const env = { HYPERDRIVE: { connectionString: "postgres://example" } };
const run = (cron: string) =>
  worker.scheduled({ cron, scheduledTime: 0, noRetry() {} } as ScheduledController, env);

describe("scheduled dispatch", () => {
  it("runs the layer sync for the weekly schedule", async () => {
    await run(SYNC_ARCGIS_LAYERS);
    expect(syncArcgisLayers).toHaveBeenCalledWith(env);
    expect(refreshIncidentLocationsJob).not.toHaveBeenCalled();
  });

  it("runs the incident refresh for the daily schedule", async () => {
    syncArcgisLayers.mockClear();
    await run(REFRESH_INCIDENT_LOCATIONS);
    expect(refreshIncidentLocationsJob).toHaveBeenCalledWith(env);
    expect(syncArcgisLayers).not.toHaveBeenCalled();
  });

  it("fails loudly for a schedule nobody registered", async () => {
    await expect(run("* * * * *")).rejects.toThrow(/No job is registered/);
  });
});
