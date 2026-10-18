import type { LayerConfig } from "./layers";
import type { ArcgisFeature } from "./types";

/**
 * Fetch every feature of an ArcGIS layer, handling pagination
 * (`resultOffset`/`exceededTransferLimit`) and requesting output in WGS84 (4326).
 *
 * TODO: implement. Not implemented in the scaffold.
 */
export async function fetchLayerFeatures(_layer: LayerConfig): Promise<ArcgisFeature[]> {
  throw new Error("Not implemented");
}
