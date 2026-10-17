import { voidPlugin } from "void";
import { defineConfig } from "vite-plus";

export default defineConfig({
  // The Void/Cloudflare plugin boots workerd, which unit tests do not need.
  plugins: process.env.VITEST ? [] : [voidPlugin()],
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
    ignorePatterns: ["db/migrations", ".void", "dist"],
  },
});
