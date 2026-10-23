import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Real Python bridge processes must run after the parallel suites, one file at a time.
const realBridgeTests = [
  "src/training/cli/commands.test.ts",
  "src/training/cli/measurement-fork.test.ts",
  "src/training/cli/proposal.test.ts",
  "src/training/cli/spawnfile/integration.test.ts",
  "src/training/cli/training/configuration.test.ts",
  "src/training/cli/training/protocol.test.ts",
  "src/training/cli/training/resume.test.ts",
  "src/training/experiments/training/routing.test.ts",
  "src/runtime/codex-exec/training/providers/codex-subscription/strict-schema-proposal.test.ts",
  "src/training/optimization/checkpoint.test.ts",
  "src/training/optimization/population.test.ts",
  "src/training/optimization/runner-home.test.ts",
  "src/training/optimization/runner.test.ts",
];

// Whole-source AST scans and nested Vitest processes contend with ordinary workers.
// Give them a serial lane on every platform; keep each project's existing deadlines.
const sourceGateTests = [
  "src/training/boundaries.test.ts",
  "src/deployment/providerRuntimeBoundary.test.ts",
  "src/ownership/mnemePublicImportBoundary.test.ts",
  "src/compiler/training/execution.mutation.test.ts",
];

// Vitest supports perFile only globally. Exact-file glob thresholds preserve
// Training's floor without applying per-file thresholds to existing Spawnfile code.
const trainingThresholds = Object.fromEntries(globSync(
  ["src/training/**/*.ts", "src/runtime/daimon/training/**/*.ts", "src/runtime/codex-exec/**/*.ts", "tooling/training/**/*.ts"],
  { cwd: fileURLToPath(new URL(".", import.meta.url)),
    exclude: ["**/*.test.ts", "**/*.d.ts", "src/training/copyAssets.ts"] },
).map(file => [file, { branches: 90, functions: 90, lines: 90, statements: 90 }]));

export default defineConfig({
  test: {
    reporters: ["default", "json"],
    outputFile: { json: "coverage/vitest-results.json" },
    coverage: {
      enabled: true,
      exclude: [
        "**/*.test.ts",
        "**/*.d.ts",
        "src/e2e/**",
        "src/!(training)/**/index.ts",
        "src/index.ts",
        "src/!(training)/**/*Types.ts",
        "src/!(training)/**/types.ts",
        "src/cli/index.ts",
        "src/ledger/causalConformanceCli.ts",
        "src/training/copyAssets.ts"
      ],
      include: ["src/**/*.ts", "tooling/training/**/*.ts"],
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      // Ratchet floors: coverage may rise, but these thresholds must not move down.
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
        "src/!(training)/**": { branches: 90, functions: 90, lines: 90, statements: 90 },
        ...trainingThresholds
      }
    },
    // Bound memory and filesystem contention across the compiler and imported training suites.
    maxWorkers: 4,
    environment: "node",
    projects: [
      { extends: true, test: { name: "spawnfile", include: ["src/**/*.test.ts"],
        exclude: [...configDefaults.exclude, ...sourceGateTests, "src/training/**", "src/runtime/daimon/training/**", "src/runtime/codex-exec/**", "src/runtime/pi/appControlDeliveryMetadata.test.ts"],
        sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: "training", include: ["src/training/**/*.test.ts", "src/runtime/daimon/training/**/*.test.ts", "src/runtime/codex-exec/**/*.test.ts", "tooling/training/**/*.test.ts"],
        exclude: [...configDefaults.exclude, ...sourceGateTests, ...realBridgeTests], testTimeout: 15_000, hookTimeout: 15_000,
        sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: "source-gates", include: sourceGateTests,
        pool: "forks", poolOptions: { forks: { singleFork: true } }, sequence: { groupOrder: 1 } } },
      { extends: true, test: { name: "real-bridge", include: realBridgeTests,
        pool: "forks", poolOptions: { forks: { singleFork: true } }, testTimeout: 15_000, hookTimeout: 15_000, sequence: { groupOrder: 2 } } }
    ],
    // Whole-src scans and durable filesystem I/O can outlive the 5s default under full-fork load.
    testTimeout: 30_000,
    exclude: [
      // This is a node:test suite, which is incompatible with the Vitest runner; npm run test:node runs it.
      "src/runtime/pi/appControlDeliveryMetadata.test.ts"
    ]
  }
});
