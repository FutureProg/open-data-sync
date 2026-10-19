import { defineEnv } from "void/env";

// No server values: the Worker reaches Postgres through the HYPERDRIVE binding
// (see void.config.ts). DATABASE_URL / DB_CA_CERT in .env are only for
// drizzle-kit (`pnpm db:migrate`) and are never deployed.
export default defineEnv({});
