import { createRequire } from "node:module";

// The Worker bundle inlines `pg`, which is CommonJS: the bundler turns its `require("events")` (and util, net,
// tls, ...) into a shim that calls a global `require`. workerd's ES-module runtime has none, so every cron died
// with "Calling `require` for "events"" before reaching the database. Under nodejs_compat `createRequire` can
// load those Node built-ins. Import this before `pg`. Reads `globalThis.require` because the bundler rewrites a bare `typeof require`.
const scope = globalThis as { require?: NodeJS.Require };
scope.require ??= createRequire("file:///");
