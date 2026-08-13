import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["default", "json"],
    outputFile: { json: "coverage/vitest-results.json" },
    coverage: {
      enabled: true,
      exclude: [
        "src/e2e/**",
        "src/**/index.ts",
        "src/**/*Types.ts",
        "src/**/types.ts",
        "src/cli/index.ts",
        "src/ledger/causalConformanceCli.ts"
      ],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      // Ratchet floors: coverage may rise, but these thresholds must not move down.
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90
      }
    },
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Whole-src scans and durable filesystem I/O can outlive the 5s default under full-fork load.
    testTimeout: 30_000,
    exclude: [
      // This is a node:test suite, which is incompatible with the Vitest runner; npm run test:node runs it.
      "src/runtime/pi/appControlDeliveryMetadata.test.ts"
    ]
  }
});
