import { describe, expect, it } from "vitest";

import { createCompileReport } from "./createReport.js";

describe("createCompileReport", () => {
  it("builds a v0.1 compile report", () => {
    expect(createCompileReport("/tmp/Spawnfile", [])).toEqual({
      diagnostics: [],
      nodes: [],
      root: "/tmp/Spawnfile",
      spawnfile_version: "0.1"
    });
  });

  it("includes container metadata when provided", () => {
    expect(
      createCompileReport(
        "/tmp/Spawnfile",
        [],
        [],
        {
          dockerfile: "Dockerfile",
          entrypoint: "entrypoint.sh",
          env_example: ".env.example",
          ports: [18789],
          runtimes_installed: ["openclaw"],
          secrets_required: ["ANTHROPIC_API_KEY"]
        }
      )
    ).toEqual({
      container: {
        dockerfile: "Dockerfile",
        entrypoint: "entrypoint.sh",
        env_example: ".env.example",
        ports: [18789],
        runtimes_installed: ["openclaw"],
        secrets_required: ["ANTHROPIC_API_KEY"]
      },
      diagnostics: [],
      nodes: [],
      root: "/tmp/Spawnfile",
      spawnfile_version: "0.1"
    });
  });
});
