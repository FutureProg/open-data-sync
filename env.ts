import { defineEnv, string, url } from "void/env";

export default defineEnv({
  // Connection string for the DigitalOcean PostgreSQL database (PostGIS enabled).
  // Local: set in .env. Production: `void secret put DATABASE_URL`.
  DATABASE_URL: url(),
  // CA certificate (PEM) of the database, used to verify its TLS connection.
  // Local: set in .env. Production: `void secret put DB_CA_CERT`.
  DB_CA_CERT: string(),
});
