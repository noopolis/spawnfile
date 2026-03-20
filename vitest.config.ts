import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: true,
      exclude: [
        "src/**/index.ts",
        "src/**/types.ts",
        "src/cli/index.ts"
      ],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "html"],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90
      }
    },
    environment: "node",
    include: ["src/**/*.test.ts"]
  }
});
