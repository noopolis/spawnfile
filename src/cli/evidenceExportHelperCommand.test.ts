import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { parsePreparedEvidenceHelperReceipt } from "../evidenceExportHelper/index.js";
import {
  createDefaultEvidenceExportHelperPreparer,
  registerEvidenceExportHelperCommand,
} from "./evidenceExportHelperCommand.js";

const receipt = parsePreparedEvidenceHelperReceipt({ digest: `sha256:${"a".repeat(64)}`,
  handle: `opaque_${"b".repeat(64)}`, version: "spawnfile.target-evidence-export-helper.prepared.v1" });
const invoke = async (argv: string[], preparer = vi.fn(async () => receipt)) => {
  const stdout: string[] = []; const stderr: string[] = []; let exitCode = 0;
  const program = new Command().exitOverride();
  registerEvidenceExportHelperCommand(program, { stderr: (message) => stderr.push(message),
    stdout: (message) => stdout.push(message) }, (value) => { exitCode = value; }, preparer);
  await program.parseAsync(argv, { from: "user" });
  return { exitCode, preparer, stderr, stdout };
};

describe("evidence export helper command", () => {
  it("routes the default preparer through the helper-specific executor", async () => {
    const executor = vi.fn(async () => { throw new Error("bounded"); });
    const executorFor = vi.fn(() => executor);
    const preparer = createDefaultEvidenceExportHelperPreparer(executorFor);
    await expect(preparer({ baseImage: "node:22-bookworm-slim", context: "local_dev",
      dockerCommand: "docker-safe", timeoutMs: 123 })).rejects.toThrow("bounded");
    expect(executorFor).toHaveBeenCalledWith("docker-safe");
    expect(executor).toHaveBeenCalledWith("docker", [
      "--context", "local_dev", "context", "inspect", "local_dev", "--format",
      "{{json .Endpoints.docker.Host}}",
    ], { timeout: 123 });
  });
  it("emits only the versioned opaque receipt", async () => {
    const result = await invoke(["helper", "prepare-evidence-export", "--context", "local_dev", "--json"]);
    expect(result.exitCode).toBe(0); expect(result.stderr).toEqual([]);
    expect(JSON.parse(result.stdout[0]!)).toEqual(receipt);
    expect(result.preparer).toHaveBeenCalledWith({ baseImage: "node:22-bookworm-slim", context: "local_dev",
      dockerCommand: "docker", timeoutMs: 120_000 });
  });
  it("redacts option and preparation failures", async () => {
    const invalid = await invoke(["helper", "prepare-evidence-export", "--context", "local_dev", "--timeout-ms", "120001", "--json"]);
    expect(invalid.exitCode).toBe(2); expect(invalid.preparer).not.toHaveBeenCalled();
    const failed = await invoke(["helper", "prepare-evidence-export", "--context", "local_dev", "--json"], vi.fn(async () => { throw new Error("private Docker detail"); }));
    expect(failed.exitCode).toBe(1); expect(failed.stderr).toEqual(["error: Prepared evidence-export helper failed"]);
  });
});
