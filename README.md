# open-data-sync

A small Cloudflare Worker, built with [Void](https://void.cloud), that syncs public municipal ArcGIS map layers (Burlington, Oakville, Milton and Halton Hills) into an existing DigitalOcean PostgreSQL database with PostGIS, every week.

See [CONTEXT.md](./CONTEXT.md) for the vocabulary used here.

## What it does

- A weekly cron (`crons/sync-arcgis-layers.ts`, Tuesdays at 00:00 UTC) connects to Postgres, calls `syncAllLayers`, and, if at least one layer was downloaded and none failed, calls `geo.refresh_curated()` and then `incidents.refresh_incident_locations(true)`.
- A daily cron (`crons/refresh-incident-locations.ts`, 19:00 UTC, an hour after the HRPS pipeline's 18:00 sync) calls `incidents.refresh_incident_locations()`. Both crons log the one-row `incidents.integration_qa` view.
- The layers to sync are listed in `src/layers.ts`.
- Raw data lands in the `open_data_sync` schema, curated data in `geo` and `incidents` (see below), via Drizzle ORM, through a [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) config that holds the database's CA (Workers cannot verify a private CA on a direct connection).
- Deployed straight to your own Cloudflare account with the Void CLI (not the Void platform).

## How a sync works

1. Upsert `LAYERS` into `arcgis_raw_layers` (a row is only updated if its town, data group or name changed), then load the enabled layers.
2. Per layer with an `editDateField` (see below), first ask the source for a fingerprint with one `queryFeatures` statistics query (`where=1=1`, `outStatistics`: count and max of the edit-date field). If it equals the fingerprint stored by the last successful sync, the layer is skipped: nothing is downloaded and no feature row is touched, only `last_synced_at` moves, and the run logs e.g. `Skipped Burlington road segments: unchanged, source last edited 2026-09-30T14:05:00.000Z, last synced 2026-10-11T06:00:00.000Z` (the per-layer summary marks it `SKIPPED (unchanged)`). If the statistics query fails or is unsupported, that is logged and the layer is fetched in full as usual; it is not a layer failure. There is no periodic forced full sync: the edit dates are trusted. Layers without an `editDateField` are always fetched in full.
3. Otherwise fetch GeoJSON in WGS84 with the Esri `@esri/arcgis-rest-feature-service` `queryAllFeatures` helper (pages by the layer's `maxRecordCount`, understands `exceededTransferLimit` at the top level or in `properties`, throws on HTTP errors and on HTTP 200 `error` bodies). Because the helper stops when the flag is missing, the received count is checked against the layer's own `returnCountOnly` count and a shortfall fails the layer. A feature's id is `feature.id`, else `OBJECTID`/`objectid`/`FID`; features with no id are skipped and counted.
4. Only if the whole fetch succeeded, in one transaction: upsert features in batches (geometry via `ST_SetSRID(ST_GeomFromGeoJSON(...), 4326)`; `synced_at` always moves, while `attributes`, `data_group` and `geometry` only change when the value differs), delete rows of that layer not seen in this run, set `last_synced_at` and save the new fingerprint (cleared when it could not be read). A failed layer never saves one. If a layer that already has stored rows comes back with zero features, that layer is treated as failed: nothing is deleted or written and `last_synced_at` is unchanged (an empty layer with no stored rows is fine).
5. A failing layer does not stop the others. A per-layer summary is logged and the run fails at the end if any layer failed.

## Tables

Both tables live in the `open_data_sync` schema (`drizzle/schema.ts`).

`arcgis_raw_layers`

| Column                     | Type                   | Notes                                                                   |
| -------------------------- | ---------------------- | ----------------------------------------------------------------------- |
| `id`                       | bigserial, pk          |                                                                         |
| `town`                     | text, not null         | Burlington, Oakville, Milton or Halton Hills                            |
| `data_group`               | text, not null         | e.g. `ward_boundaries`, `road_segments`, `intersections`                |
| `name`                     | text                   |                                                                         |
| `service_url`              | text, not null, unique | ArcGIS layer URL ending in `/MapServer/N` or `/FeatureServer/N`         |
| `enabled`                  | boolean, default true  |                                                                         |
| `last_synced_at`           | timestamptz, null      | moves on every run, including skipped ones                              |
| `source_feature_count`     | integer, null          | fingerprint saved by the last full sync of a layer with `editDateField` |
| `source_last_edited_at`    | timestamptz, null      | latest edit date in the source at that time                             |
| `created_at`, `updated_at` | timestamptz            |                                                                         |

`arcgis_raw_features`

| Column              | Type                                    | Notes                       |
| ------------------- | --------------------------------------- | --------------------------- |
| `id`                | bigserial, pk                           |                             |
| `layer_id`          | bigint, fk to layers, on delete cascade |                             |
| `data_group`        | text, not null                          | denormalized for indexing   |
| `source_feature_id` | text, not null                          | ArcGIS OBJECTID or GlobalID |
| `attributes`        | jsonb, not null                         |                             |
| `geometry`          | `geometry(Geometry,4326)`               | any geometry type; nullable |
| `synced_at`         | timestamptz, not null                   |                             |

Unique on (`layer_id`, `source_feature_id`). Indexes: btree on `data_group`, btree on `layer_id`, GiST on `geometry`.

## Curated tables

Post-processing runs as SQL inside Postgres (migrations `0003_curated_views.sql` and `0004_intersections_t_junctions.sql`), in two schemas split by domain so each can be granted on its own:

- `geo`: Halton reference geography, reusable by anything map-based.
- `incidents`: police incident enrichment. It reads `geo`; `geo` never reads `incidents` (a test checks this).

`safe_streets_halton.hrps_data` is only read, never changed. Distances use EPSG:2958 (metres).

| Object                           | Kind              | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `geo.layer_field_map`            | table             | Which attribute of each town's layer holds ward number, ward name, street name and road class. Seeded from `src/field-map.ts`; a test fails if they drift.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `geo.wards`                      | materialized view | One row per ward: `ward_id` (`milton-2`), `town`, `ward_number`, `ward_name`, `geom`, `geom_m`, `geom_display` (simplified to about 5 m).                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `geo.road_segments`              | materialized view | Road features as LineStrings with a normalized `street_name` ("BRANT ST." and "Brant Street" match).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `geo.is_highway_name`            | function          | True for 400-series highway, QEW, eastbound/westbound and "... To ..." ramp names. Highway 5 and 25 are arterial roads and do not match.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `geo.intersections`              | materialized view | Derived for all four towns from road segment end points: nodes within 3 m, two or more distinct streets (a street that ends on the side of another, a T-junction, counts at that spot; highway and ramp names, per `geo.is_highway_name`, are left out so overpasses are not intersections), merged within 20 m when they share a street (divided roads, roundabouts, boundary roads). Burlington's published layer is only a check. `intersection_id` is the point's 10-character geohash (a `-2`, `-3` suffix only if two ever share a cell), so it is URL-safe and independent of the town. |
| `incidents.incident_type_groups` | table             | Collision / injury-or-fatal flags per HRPS description. An unknown description shows in `integration_qa` until it is added.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `incidents.incident_locations`   | table             | Per incident (`global_id` = `hrps_data."globalId"`): town, ward (polygon cover; lower `ward_id` on a boundary; nearest within 50 m), nearest intersection within 30 m.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `incidents.integration_qa`       | view              | One row of counts for the logs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

`geo.refresh_curated()` rebuilds the three geo views only. `incidents.refresh_incident_locations()` is incremental (new or changed incidents; deletes rows whose incident is gone); pass `true` to recompute every incident, which the weekly cron does after a geo rebuild. After a migration that changes `geo.intersections`, run `select incidents.refresh_incident_locations(true)` so incidents link to the new intersections.

Before `pnpm db:migrate`, the database owner creates the `geo` and `incidents` schemas and grants the migration role `CREATE` on them (migrations never create schemas), and grants the Worker's role `USAGE` and read/write on `geo` and `incidents` plus `SELECT` on `safe_streets_halton.hrps_data`. Run `pnpm db:migrate` before deploying; the migration fails if `hrps_data` does not exist.

The opt-in baseline test (`tests/integration/baseline.test.ts`) syncs the live layers into a throwaway container, loads the 2024 HRPS export and checks the QA numbers and the Burlington cross-check:
`HRPS_BACKFILL_GEOJSON=/path/to/crime_map_jan_1_2024.geojson pnpm exec vp test run tests/integration/baseline.test.ts`

## Adding a layer

1. Add an entry to `LAYERS` in `src/layers.ts` with `town`, `dataGroup`, `name` and the layer `url` (use `TODO` and a comment if the URL is not resolved yet).
   Optionally set `editDateField` to the layer's last-edited date field (check the layer metadata) to skip downloads while the source is unchanged. The feature count in the fingerprint counts non-null values of that field.
   1b. If it is a ward or road layer, add its town's field names to `src/field-map.ts` and a migration row for `layer_field_map`.
2. If it needs a new data group, add it to `DATA_GROUPS` in the same file.
3. Run `pnpm exec vp test run` (URLs must be unique and values valid).
4. On the next run the sync upserts `LAYERS` into `arcgis_raw_layers` (keyed on `service_url`; an existing row keeps its `enabled` flag). Layers with a `TODO` URL are skipped.

## Environment variables

Void reads local values from a single `.env` file only (copy `example.env` to `.env`; Void rejects `.env.example`). The schema is declared in `env.ts`.

| Variable                                                   | Used for                                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                             | PostgreSQL connection string. Only for manual migrations (`pnpm db:migrate`); never deployed. |
| `DB_CA_CERT`                                               | The database's CA certificate (PEM), used by drizzle-kit for verified TLS.                    |
| `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` | Where `vp dev` connects for the `HYPERDRIVE` binding. Use a local Postgres.                   |
| `CLOUDFLARE_API_TOKEN`                                     | Non-interactive deploys (CI). Workers Scripts: Edit.                                          |
| `CLOUDFLARE_ACCOUNT_ID`                                    | Needed when the token can reach several accounts.                                             |

Never commit `.env`. Local `.env` values are never deployed. The deployed Worker needs no secrets: its database access comes from the Hyperdrive config.

## Local development

Void requires Node 24.21 or newer. The project uses pnpm and [Vite+](https://viteplus.dev) (`vp`).

```sh
pnpm install
cp example.env .env        # fill in DATABASE_URL/DB_CA_CERT (migrations) and a local Postgres for dev
pnpm exec vp dev           # or: pnpm dev
pnpm test                  # unit tests, plus PostGIS integration tests when Docker is running
pnpm exec vp check         # format, lint, type check
pnpm typecheck             # tsc
pnpm db:generate           # generate a migration after editing drizzle/schema.ts
pnpm db:migrate            # apply migrations by hand (needs DATABASE_URL and DB_CA_CERT)
```

The integration tests (`tests/integration`) start a throwaway `postgis/postgis` container with Testcontainers, create the schemas, the extension and a stand-in `hrps_data` table in test setup, and apply the real migrations. They are skipped with a warning when Docker is not available.

Schedules do not fire locally. Trigger one with the dev token Void prints at start-up:

```sh
curl -X POST http://localhost:5173/__void/scheduled \
  -H "Content-Type: application/json" -H "x-void-dev-trigger: <token>" \
  -d '{"cron":"0 6 * * 1","scheduledTime":'"$(date +%s000)"'}'
```

To run the sync once by hand, for example after a missed cron, use `pnpm sync:once`. It runs in plain Node and connects to the database in `.env` (`DATABASE_URL`, with `DB_CA_CERT` for verified TLS), so it writes to that database. Leave `DB_CA_CERT` empty to use a local, non-TLS Postgres. It must not run inside workerd (`vp dev`), which cannot verify the DigitalOcean CA.

## Deploy

```sh
pnpm exec void deploy --platform cloudflare     # or: pnpm run deploy:cf
```

The first run signs in to Cloudflare in a browser. Before the first deploy, run `pnpm db:migrate` and create the Hyperdrive config once (Wrangler 4.9+):

```sh
npx wrangler cert upload certificate-authority --ca-cert ca.pem --name open-data-sync-db-ca
npx wrangler hyperdrive create open-data-sync --connection-string="postgresql://USER:PASS@HOST:PORT/DB" \
  --ca-certificate-id <id from the upload> --sslmode verify-full
```

Put the returned config ID in `cloudflare.hyperdrive` in `void.config.ts`. Commit `void.lock.json` once Void creates it.

## Notes

- **Migrations are manual.** Void's database layer is not used, so `void deploy` does not touch the database. Run `pnpm db:migrate` (drizzle-kit) yourself; it records progress in `open_data_sync.__drizzle_migrations`, so nothing is written outside the schema. The migration SQL does not run `CREATE SCHEMA` or `CREATE EXTENSION`, but drizzle's migrator runs `CREATE SCHEMA IF NOT EXISTS open_data_sync` for its tracking table, which Postgres refuses without `CREATE` on the database. Grant it once: `GRANT CREATE ON DATABASE <db> TO "<role>";`.
- **The `open_data_sync`, `geo` and `incidents` schemas must already exist**, and the role must be able to create tables in them.
- **PostGIS must be enabled** in the database (the owner says it already is). Migrations rely on it but never enable it.
- **DigitalOcean trusted sources** may need to allow Cloudflare, since Workers have no fixed outgoing IP. Verify this against your database settings.
- **TLS.** Hyperdrive verifies the database against the uploaded CA (`verify-full`). The Worker's own connection to Hyperdrive has no TLS. Local `vp dev` cannot reach the DigitalOcean database directly for the same reason, so point it at a local Postgres.
- Layers whose URL is `TODO` in `src/layers.ts` are skipped until resolved.
