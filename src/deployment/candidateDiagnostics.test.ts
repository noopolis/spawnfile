import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureCandidateDiagnostics, sanitizeCandidateDiagnostic } from "./candidateDiagnostics.js";
import type { DockerCommandRunner } from "../distribution/dockerRunner.js";

const candidateId = "c".repeat(64);
let home: string;
let deployment: string;
const previousHome = process.env.SPAWNFILE_HOME;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "candidate-diagnostics-"));
  process.env.SPAWNFILE_HOME = home;
  deployment = path.join(home, "deployments", "candidate");
  await mkdir(deployment, { recursive: true });
});
afterEach(async () => {
  if (previousHome === undefined) delete process.env.SPAWNFILE_HOME;
  else process.env.SPAWNFILE_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

const runner = (state: unknown = { Status: "running", Health: { Status: "unhealthy" }, ExitCode: 0 }): DockerCommandRunner =>
  async args => Buffer.from(args[0] === "logs" ? "Error: required module not found\nknown-secret" : JSON.stringify(state));
const capture = (runDocker: DockerCommandRunner = runner()) => captureCandidateDiagnostics({
  candidateId, deploymentName: "candidate", runDocker, secretValues: ["known-secret"]
});

describe("failed candidate diagnostics", () => {
  it("writes private unique evidence with allowlisted health fields and bounded sanitized logs", async () => {
    const runDocker = vi.fn(runner({
      Running: false, Status: "exited", ExitCode: 137, OOMKilled: true,
      Error: "module failed known-secret", ignored: "unknown-private-value",
      Health: { Status: "unhealthy", Log: [
        { Output: "first old health output" }, { Output: "known-secret" }, { Output: "not listening" },
        { Output: "a".repeat(5_000) }
      ] }
    }));
    const first = await capture(runDocker), second = await capture(runDocker);
    expect(first.path).not.toBe(second.path);
    expect(first.summary).toBe("state=exited, health=unhealthy, exit=137, oom-killed");
    const text = await readFile(first.path!, "utf8"), evidence = JSON.parse(text);
    expect(text).toContain("required module not found");
    expect(text).not.toMatch(/known-secret|unknown-private-value|first old health output/u);
    expect(evidence.health.healthOutput).toHaveLength(3);
    expect(evidence.health.healthOutput[2]).toHaveLength(4_096);
    expect((await stat(first.path!)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(first.path!))).mode & 0o777).toBe(0o700);
    for (const [args, options] of runDocker.mock.calls) {
      expect(args.at(-1)).toBe(candidateId);
      expect(options).toEqual({ captureStderr: true, maxOutputBytes: 65_536, timeoutMs: 5_000 });
      expect(args).not.toContain("--follow");
    }
  });

  it("preserves useful health metadata even when short env values redact log text", async () => {
    const result = await captureCandidateDiagnostics({ candidateId, deploymentName: "candidate",
      runDocker: runner({ Status: "exited", ExitCode: 1 }), secretValues: ["x", "1"] });
    expect(result.summary).toBe("state=exited, exit=1");
  });

  it.each([null, "malformed", { Status: "injected-secret", Health: { Status: "private-health" } }])(
    "never surfaces arbitrary state metadata: %j", async value => {
      const result = await capture(runner(value));
      expect(result.summary).toMatch(/^state (?:unavailable)$|^state=unknown$/u);
      expect(await readFile(result.path!, "utf8")).not.toMatch(/injected-secret|private-health/u);
    });

  it("records collection failure without persisting raw Docker errors", async () => {
    const result = await capture(async () => { throw new Error("transport arbitrary-private-value"); });
    const text = await readFile(result.path!, "utf8");
    expect(text).not.toContain("arbitrary-private-value");
    expect(JSON.parse(text).logs.available).toBe(false);
    expect(result.summary).toBe("state unavailable");
  });

  it("rejects oversized output from injectable command runners", async () => {
    const result = await capture(async () => Buffer.alloc(65_537, "x"));
    const evidence = JSON.parse(await readFile(result.path!, "utf8"));
    expect(evidence.logs.available).toBe(false);
    expect(evidence.health.available).toBe(false);
  });

  it("reports absent diagnostics when storage is unavailable, without throwing", async () => {
    await writeFile(path.join(deployment, "diagnostics"), "occupied");
    await expect(capture()).resolves.toEqual({ path: null, summary: "state=running, health=unhealthy, exit=0" });
  });

  it("refuses a public or symlinked diagnostic directory", async () => {
    const directory = path.join(deployment, "diagnostics");
    await mkdir(directory, { mode: 0o755 });
    expect((await capture()).path).toBeNull();
    await rm(directory, { recursive: true });
    const target = path.join(home, "unrelated");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, directory);
    expect((await capture()).path).toBeNull();
    expect(await readdir(target)).toEqual([]);
  });

  it("refuses writable deployment parents and invalid candidate identities", async () => {
    await chmod(deployment, 0o777);
    expect((await capture()).path).toBeNull();
    const runDocker = vi.fn(runner());
    expect(await captureCandidateDiagnostics({ candidateId: "ambiguous", deploymentName: "candidate", runDocker, secretValues: [] }))
      .toEqual({ path: null, summary: "invalid candidate identity" });
    expect(runDocker).not.toHaveBeenCalled();
  });

  it("sanitizes known values, token shapes, URLs, keys and terminal control characters", () => {
    const original = [
      "known-secret", "Bearer abcdefghijklmnop", "sk-proj-abcdefghijklmnopqrstuvwxyz",
      "TOKEN=value", '{"refreshToken":"refresh-value"}', "Authorization: Basic basic-credential",
      "https://user:pass@example.org/private?token=foo", "eyJhbGciOiJIUzI1NiJ9.payload.signature",
      "-----BEGIN PRIVATE KEY-----\nprivate-key-bytes\n-----END PRIVATE KEY-----",
      "\u001b[31mError: missing module\u001b[0m"
    ].join("\n");
    const clean = sanitizeCandidateDiagnostic(original, ["known-secret"]);
    expect(clean).not.toMatch(/known-secret|abcdefghijklmnop|refresh-value|basic-credential|user:pass|eyJhbGci|private-key-bytes|\u001b/u);
    expect(clean).toContain("Error: missing module");
  });
});
