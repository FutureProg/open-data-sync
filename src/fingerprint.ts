import { queryFeatures } from "@esri/arcgis-rest-feature-service";

/** What we compare between runs to tell whether a source layer changed. */
export interface SourceFingerprint {
  featureCount: number;
  /** Latest value of the layer's edit-date field; null only for an empty layer. */
  lastEditedAt: Date | null;
}

const COUNT_NAME = "feature_count";
const LATEST_EDIT_NAME = "latest_edit";

function readStatistic(attributes: Record<string, unknown>, name: string): unknown {
  const key = Object.keys(attributes).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : attributes[key];
}

/**
 * Ask the source layer for its feature count and latest edit date with a single
 * statistics query. Throws when the server rejects the query or answers with
 * something that cannot serve as a fingerprint.
 */
export async function fetchSourceFingerprint(
  layerUrl: string,
  editDateField: string,
): Promise<SourceFingerprint> {
  const response = (await queryFeatures({
    url: layerUrl,
    where: "1=1",
    returnGeometry: false,
    outStatistics: [
      {
        statisticType: "count",
        onStatisticField: editDateField,
        outStatisticFieldName: COUNT_NAME,
      },
      {
        statisticType: "max",
        onStatisticField: editDateField,
        outStatisticFieldName: LATEST_EDIT_NAME,
      },
    ],
  })) as { features?: { attributes?: Record<string, unknown> }[] };

  const attributes = response.features?.[0]?.attributes;
  if (!attributes) throw new Error("the statistics query returned no result row");

  const featureCount = readStatistic(attributes, COUNT_NAME);
  if (typeof featureCount !== "number") {
    throw new Error("the statistics query returned no feature count");
  }
  const latestEdit = readStatistic(attributes, LATEST_EDIT_NAME);
  if (latestEdit === null || latestEdit === undefined) {
    if (featureCount > 0) {
      throw new Error(`no feature has a value in ${editDateField}`);
    }
    return { featureCount, lastEditedAt: null };
  }
  if (typeof latestEdit !== "number") {
    throw new Error(`the latest value of ${editDateField} is not a date`);
  }
  return { featureCount, lastEditedAt: new Date(latestEdit) };
}

export function sameFingerprint(left: SourceFingerprint, right: SourceFingerprint): boolean {
  return (
    left.featureCount === right.featureCount &&
    left.lastEditedAt?.getTime() === right.lastEditedAt?.getTime()
  );
}

export type SyncPlan =
  | { action: "skip"; message: string }
  /** `fingerprint` is what to store after a successful sync; null when it is unknown. */
  | { action: "fetch"; fingerprint: SourceFingerprint | null };

export interface PlanLayerSyncInput {
  layerName: string;
  layerUrl: string;
  editDateField: string;
  stored: { fingerprint: SourceFingerprint | null; lastSyncedAt: Date | null };
  log: (message: string) => void;
}

/**
 * Decide whether a layer needs downloading. A failed statistics query is logged
 * and answered with a normal full fetch; it is never a layer failure.
 */
export async function planLayerSync(input: PlanLayerSyncInput): Promise<SyncPlan> {
  const { layerName, layerUrl, editDateField, stored, log } = input;
  let current: SourceFingerprint;
  try {
    current = await fetchSourceFingerprint(layerUrl, editDateField);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`Could not read the edit-date fingerprint of ${layerName} (${reason}); doing a full fetch`);
    return { action: "fetch", fingerprint: null };
  }
  if (stored.fingerprint && sameFingerprint(stored.fingerprint, current)) {
    const edited = current.lastEditedAt?.toISOString() ?? "never (empty layer)";
    const synced = stored.lastSyncedAt?.toISOString() ?? "unknown";
    return {
      action: "skip",
      message: `Skipped ${layerName}: unchanged, source last edited ${edited}, last synced ${synced}`,
    };
  }
  return { action: "fetch", fingerprint: current };
}
