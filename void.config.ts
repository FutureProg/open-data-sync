import { defineConfig } from "void/config";

export default defineConfig({
  target: "cloudflare",
  // No `database`: Void's database layer (D1 / Void-managed migrations) is unused.
  // The Worker reaches the external Postgres through a Hyperdrive config we
  // created ourselves (it holds the database's CA); see README.
  worker: {
    compatibility_date: "2026-02-24",
    compatibility_flags: ["nodejs_compat"],
  },
  cloudflare: {
    name: "open-data-sync",
    hyperdrive: [
      {
        binding: "HYPERDRIVE",
        id: "19ea5aa02771494897c2cf7998977211",
      },
    ],
    preview_urls: true,
    workers_dev: true,
    // Workers Logs and real-time Issues. Cloudflare turns them off for any version
    // deployed without them, so they have to be declared here.
    observability: {
      enabled: true,
      logs: { enabled: true, invocation_logs: true },
      issues: { enabled: true },
    },
  },
});
