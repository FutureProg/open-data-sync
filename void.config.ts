import { defineConfig } from "void/config";

export default defineConfig({
  target: "cloudflare",
  // No `database`: this Worker talks to the external Postgres directly over TCP
  // (src/db.ts), without Hyperdrive and without Void's database layer.
  worker: {
    compatibility_date: "2026-02-24",
    compatibility_flags: ["nodejs_compat"],
    
  },
  cloudflare: {
    name: "open-data-sync",
    preview_urls: true,
    workers_dev: true
  },
});
