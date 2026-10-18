# open-data-sync

A small Cloudflare Worker, built with [Void](https://void.cloud), that syncs public municipal ArcGIS map layers (Burlington, Oakville, Milton and Halton Hills) into an existing DigitalOcean PostgreSQL database with PostGIS, every week.

See [CONTEXT.md](./CONTEXT.md) for the vocabulary used here.

## What it does

- A weekly cron (`crons/sync-arcgis-layers.ts`, Mondays at 06:00 UTC) connects to Postgres and calls `syncAllLayers`.
- The layers to sync are listed in `src/layers.ts`.
- Data lands in the `open_data_sync` schema, via Drizzle ORM, over a direct Postgres connection (no Hyperdrive).
- Deployed straight to your own Cloudflare account with the Void CLI (not the Void platform).

## How a sync works

1. Upsert `LAYERS` into `arcgis_raw_layers`, then load the enabled layers.
2. Per layer, page through `<layer>/query?where=1=1&outFields=*&outSR=4326&f=geojson` using `resultOffset`/`resultRecordCount` (page size is the layer's `maxRecordCount`, default 1000). An HTTP 200 with a JSON `error` body counts as a failure. A feature's id is `feature.id`, else `OBJECTID`/`objectid`/`FID`; features with no id are skipped and counted.
3. Only if the whole fetch succeeded, in one transaction: upsert features in batches (geometry via `ST_SetSRID(ST_GeomFromGeoJSON(...), 4326)`), delete rows of that layer not seen in this run, and set `last_synced_at`.
4. A failing layer does not stop the others. A per-layer summary is logged and the run fails at the end if any layer failed.

## Tables

Both tables live in the `open_data_sync` schema (`db/schema.ts`).

`arcgis_raw_layers`

| Column                     | Type                   | Notes                                                           |
| -------------------------- | ---------------------- | --------------------------------------------------------------- |
| `id`                       | bigserial, pk          |                                                                 |
| `town`                     | text, not null         | Burlington, Oakville, Milton or Halton Hills                    |
| `data_group`               | text, not null         | e.g. `ward_boundaries`, `road_segments`, `intersections`        |
| `name`                     | text                   |                                                                 |
| `service_url`              | text, not null, unique | ArcGIS layer URL ending in `/MapServer/N` or `/FeatureServer/N` |
| `enabled`                  | boolean, default true  |                                                                 |
| `last_synced_at`           | timestamptz, null      |                                                                 |
| `created_at`, `updated_at` | timestamptz            |                                                                 |

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

## Adding a layer

1. Add an entry to `LAYERS` in `src/layers.ts` with `town`, `dataGroup`, `name` and the layer `url` (use `TODO` and a comment if the URL is not resolved yet).
2. If it needs a new data group, add it to `DATA_GROUPS` in the same file.
3. Run `pnpm exec vp test run` (URLs must be unique and values valid).
4. On the next run the sync upserts `LAYERS` into `arcgis_raw_layers` (keyed on `service_url`; an existing row keeps its `enabled` flag). Layers with a `TODO` URL are skipped.

## Environment variables

Void reads local values from a single `.env` file only (copy `example.env` to `.env`; Void rejects `.env.example`). The schema is declared in `env.ts`.

| Variable                | Used for                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | PostgreSQL connection string. Local dev, manual migrations, and the deployed Worker (as a secret). |
| `DB_CA_CERT`            | The database's CA certificate (PEM). The connection always uses TLS verified against it.           |
| `CLOUDFLARE_API_TOKEN`  | Non-interactive deploys (CI). Workers Scripts: Edit.                                               |
| `CLOUDFLARE_ACCOUNT_ID` | Needed when the token can reach several accounts.                                                  |

Never commit `.env`. Local `.env` values are never deployed: set production values once with `pnpm exec void secret put`.

## Local development

Void requires Node 24.21 or newer. The project uses pnpm and [Vite+](https://viteplus.dev) (`vp`).

```sh
pnpm install
cp example.env .env        # then fill in DATABASE_URL and DB_CA_CERT
pnpm exec vp dev           # or: pnpm dev
pnpm test                  # unit tests, plus PostGIS integration tests when Docker is running
pnpm exec vp check         # format, lint, type check
pnpm typecheck             # tsc
pnpm db:generate           # generate a migration after editing db/schema.ts
pnpm db:migrate            # apply migrations by hand (needs DATABASE_URL and DB_CA_CERT)
```

The integration tests (`tests/integration`) start a throwaway `postgis/postgis` container with Testcontainers, create the schema and extension in test setup, and apply the real migrations. They are skipped with a warning when Docker is not available.

Schedules do not fire locally. Trigger one with the dev token Void prints at start-up:

```sh
curl -X POST http://localhost:5173/__void/scheduled \
  -H "Content-Type: application/json" -H "x-void-dev-trigger: <token>" \
  -d '{"cron":"0 6 * * 1","scheduledTime":'"$(date +%s000)"'}'
```

## Deploy

```sh
pnpm exec void deploy --platform cloudflare     # or: pnpm run deploy:cf
```

The first run signs in to Cloudflare in a browser. Run `pnpm exec void secret put DATABASE_URL` and `pnpm exec void secret put DB_CA_CERT` once so the Worker can reach the database, and `pnpm db:migrate` before the first run. Commit `void.lock.json` once Void creates it.

## Notes

- **Migrations are manual.** Void's database layer is not used, so `void deploy` does not touch the database. Run `pnpm db:migrate` (drizzle-kit) yourself; it records progress in `open_data_sync.__drizzle_migrations`, so nothing is written outside the schema. The migration does not run `CREATE SCHEMA` or `CREATE EXTENSION`.
- **The `open_data_sync` schema must already exist**, and the role must be able to create tables in it.
- **PostGIS must be enabled** in the database (the owner says it already is). Migrations rely on it but never enable it.
- **DigitalOcean trusted sources** may need to allow Cloudflare, since Workers have no fixed outgoing IP. Verify this against your database settings.
- **TLS.** The connection always uses TLS and verifies the server against `DB_CA_CERT`. Any `sslmode` in `DATABASE_URL` is ignored.
- Layers whose URL is `TODO` in `src/layers.ts` are skipped until resolved.
