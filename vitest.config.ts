import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only our own sources; never the vendored PoB / pob-web checkouts.
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", ".vendor/**", "pob-src/**"],
  },
});
