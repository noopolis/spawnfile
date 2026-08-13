import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ExportRunArtifactsResult } from "../deployment/index.js";

import { runCli } from "./runCli.js";

const projectRoot = "/tmp/spawnfile-artifacts-cli-project";

const createResult = (overrides: Partial<ExportRunArtifactsResult> = {}): ExportRunArtifactsResult => ({
  deploymentName: "default",
  failedFiles: [],
  index: {
    deployment: "default",
    exported_at: "2026-07-11T00:00:00.000Z",
    files: [
      {
        bytes: 42,
        path: "raw/moltnet/causal.jsonl",
        sha256: "a".repeat(64),
        source: { kind: "volume", ref: "vol:/causal.jsonl" }
      }
    ],
    run_id: "run-abc123",
    version: "spawnfile.export-index.v1"
  },
  indexPath: "/tmp/export-out/spawnfile/export-index.json",
  missingOptionalFiles: [],
  ...overrides
});

describe("spawnfile artifacts export", () => {
  it("resolves the compiled output directory from the project path and forwards options", async () => {
    const exportRunArtifacts = vi.fn(async () => createResult());
    const stdout: string[] = [];

    const exitCode = await runCli(
      [
        "artifacts", "export", projectRoot,
        "--out", "/tmp/export-out",
        "--deployment", "prod",
        "--docker-command", "podman",
        "--reader-image", "spawnfile-project:latest",
        "--timeout", "5000"
      ],
      { stderr: () => undefined, stdout: (message) => stdout.push(message) },
      { exportRunArtifacts }
    );

    expect(exitCode).toBe(0);
    expect(exportRunArtifacts).toHaveBeenCalledWith({
      compiledOutputDirectory: path.join(projectRoot, ".spawn"),
      deploymentName: "prod",
      destinationDirectory: "/tmp/export-out",
      dockerCommand: "podman",
      readerImage: "spawnfile-project:latest",
      runId: undefined,
      timeoutMs: 5000
    });
    expect(stdout).toEqual([
      "exported 1 file(s) to /tmp/export-out",
      "deployment: default",
      "run: run-abc123",
      "index: /tmp/export-out/spawnfile/export-index.json"
    ]);
  });

  it("supports --run-id instead of --deployment", async () => {
    const exportRunArtifacts = vi.fn(async () => createResult());

    await runCli(
      ["artifacts", "export", projectRoot, "--out", "/tmp/export-out", "--run-id", "run-xyz"],
      { stderr: () => undefined, stdout: () => undefined },
      { exportRunArtifacts }
    );

    expect(exportRunArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentName: undefined, runId: "run-xyz" })
    );
  });

  it("requires an explicit flag before forwarding private artifact export", async () => {
    const exportRunArtifacts = vi.fn(async () => createResult());

    await runCli(
      [
        "artifacts", "export", projectRoot,
        "--out", "/tmp/export-out",
        "--deployment", "default",
        "--include-private"
      ],
      { stderr: () => undefined, stdout: () => undefined },
      { exportRunArtifacts }
    );

    expect(exportRunArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ includePrivate: true })
    );
  });

  it("honors --compiled to override the compile output directory", async () => {
    const exportRunArtifacts = vi.fn(async () => createResult());

    await runCli(
      [
        "artifacts", "export", projectRoot,
        "--out", "/tmp/export-out",
        "--deployment", "default",
        "--compiled", "/tmp/custom-compiled-out"
      ],
      { stderr: () => undefined, stdout: () => undefined },
      { exportRunArtifacts }
    );

    expect(exportRunArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ compiledOutputDirectory: path.resolve("/tmp/custom-compiled-out") })
    );
  });

  it("renders machine-readable JSON with --json", async () => {
    const exportRunArtifacts = vi.fn(async () => createResult({
      failedFiles: ["raw/daimon/eleanor/causal.jsonl"],
      missingOptionalFiles: ["raw/mneme/office-recall/causal.jsonl"]
    }));
    const stdout: string[] = [];

    const exitCode = await runCli(
      ["artifacts", "export", projectRoot, "--out", "/tmp/export-out", "--deployment", "default", "--json"],
      { stderr: () => undefined, stdout: (message) => stdout.push(message) },
      { exportRunArtifacts }
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.join("\n"));
    expect(parsed).toMatchObject({
      deployment: "default",
      failed_files: ["raw/daimon/eleanor/causal.jsonl"],
      missing_optional_files: ["raw/mneme/office-recall/causal.jsonl"]
    });
    expect(parsed.index.version).toBe("spawnfile.export-index.v1");
  });

  it("requires --out", async () => {
    const exportRunArtifacts = vi.fn(async () => createResult());
    const stderr: string[] = [];

    const exitCode = await runCli(
      ["artifacts", "export", projectRoot, "--deployment", "default"],
      { stderr: (message) => stderr.push(message), stdout: () => undefined },
      { exportRunArtifacts }
    );

    // Missing a required option is a usage error (exit code 2), not a runtime failure.
    expect(exitCode).toBe(2);
    expect(exportRunArtifacts).not.toHaveBeenCalled();
  });
});
