import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
  // The Cloudflare plugin boots workerd, which unit tests do not need.
  plugins: process.env.VITEST ? [] : [cloudflare()],
  staged: {
    "*": "vp check --fix",
  },
  lint: {
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
  fmt: {
    ignorePatterns: ["drizzle/migrations", ".cloudflare", "dist"],
  },
});
