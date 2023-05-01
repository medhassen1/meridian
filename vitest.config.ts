import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Routing is pure computation over in-memory feeds, so tests never need
    // isolation from each other and a single fork keeps ordering stable.
    // Determinism matters more here than wall-clock speed.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    sequence: {
      shuffle: false,
      concurrent: false,
    },
    reporters: ["default"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Barrels only re-export; they carry no behaviour worth covering.
      exclude: ["src/**/index.ts"],
      reporter: ["text", "json-summary", "lcov"],
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
