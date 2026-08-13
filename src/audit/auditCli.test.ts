import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runAuditCli } from "./auditCli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const goodFixturePath = path.join(__dirname, "fixtures", "good");

describe("runAuditCli", () => {
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
    vi.restoreAllMocks();
  });

  const writtenTo = (stream: NodeJS.WriteStream): string =>
    (stream.write as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) => call[0]).join("");

  it("prints the report JSON to stdout and leaves exitCode unset for the good fixture", async () => {
    await runAuditCli(["--fixtures", goodFixturePath, "--required-secret", "OPENAI_API_KEY"]);

    expect(process.exitCode).toBeUndefined();
    const report = JSON.parse(writtenTo(process.stdout));
    expect(report.schema).toBe("spawnfile.audit.v1");
    expect(report.summary).toEqual({ failed: 0, na: 1, passed: 6 });

    expect(writtenTo(process.stderr)).toContain("6 passed, 0 failed, 1 n/a");
  });

  it("writes the report to --out instead of stdout, and sets exitCode 1 for a fixture with a failing check", async () => {
    const brokenFixturePath = path.join(__dirname, "fixtures", "broken-silent-drop");
    const outDir = await mkdtemp(path.join(tmpdir(), "spawnfile-audit-cli-"));
    const outPath = path.join(outDir, "report.json");

    try {
      await runAuditCli([
        "--fixtures",
        brokenFixturePath,
        "--required-secret",
        "OPENAI_API_KEY",
        "--out",
        outPath
      ]);

      expect(process.exitCode).toBe(1);
      expect(writtenTo(process.stdout)).toBe("");

      const written = JSON.parse(await readFile(outPath, "utf8"));
      const check = written.checks.find((entry: { id: string }) => entry.id === "causal.denied-ledger-visible");
      expect(check.status).toBe("fail");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("supports independent --compiled-output and --ledger directories", async () => {
    await runAuditCli([
      "--compiled-output",
      goodFixturePath,
      "--ledger",
      goodFixturePath,
      "--required-secret",
      "OPENAI_API_KEY"
    ]);

    expect(process.exitCode).toBeUndefined();
  });

  it("throws when neither --fixtures nor --compiled-output is given", async () => {
    await expect(runAuditCli([])).rejects.toThrow(/requires --fixtures/);
  });
});
