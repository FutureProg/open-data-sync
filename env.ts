import { defineEnv, url } from "void/env";

export default defineEnv({
  // Connection string for the DigitalOcean PostgreSQL database (PostGIS enabled).
  // Local: set in .env. Production: `void secret put DATABASE_URL`.
  DATABASE_URL: url(),
});
