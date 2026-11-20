import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, beforeEach, expect, it } from "vitest";

import { withSyntheticAdapter } from "../deployment/syntheticRuntimeAdapter.test-helper.js";
import { resolveReleasePaths } from "./ledger.js";
import type { RunningUnit } from "./releaseDocker.js";
import type { ReleaseDependencies, ReleaseRequest } from "./releaseTypes.js";
import { runRelease } from "./runRelease.js";

const IDENTITY = `sha256:${"a".repeat(64)}`;
const OLD_IMAGE = `sha256:${"1".repeat(64)}`;
const NEW_IMAGE = `sha256:${"2".repeat(64)}`;
const SYNTHETIC = "synthetic-runtime";
const target = { endpoint_fingerprint: "sha256:local", kind: "context", name: "default" } as const;

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-release-adapters-")); });
afterEach(async () => { await rm(root, { force: true, recursive: true }); });

const unit = (imageId: string, id = "c".repeat(64)): RunningUnit => ({ health: "healthy", id, imageId, restartCount: 0, running: true });

const request = (): ReleaseRequest => ({
  bundleIdentity: "release", deployment: "org", dockerCommand: "docker", drain: true, drainPollMs: 1,
  drainTimeoutMs: 1_000, envFileEnv: {}, force: false, inputPath: "/project", log: () => undefined,
  notifier: { kind: "none" }, notifyDeferredAfterMs: 3_600_000, releaseRoot: root,
  settle: { pollMs: 1, polls: 3, stablePolls: 2 }
});

/** Fake effects only: every call is recorded, nothing reaches Docker. */
const harness = (options: { compiled: string[]; running: string[] }) => {
  const calls: string[] = [];
  let current: RunningUnit | null = unit(OLD_IMAGE);
  const deps: ReleaseDependencies = {
    async build(_request, _compiled, imageTag) { calls.push("build"); return { buildMs: 1, imageId: NEW_IMAGE, imageTag, skipped: false }; },
    async compile() {
      calls.push("compile");
      const runtime_instances = options.compiled.map((runtime) => ({ runtime }));
      return { compileMs: 1, compileResult: { report: { compile_fingerprint: "sf1:x", container: { runtime_instances } } } as never, identity: IDENTITY, repository: "spawnfile-org" };
    },
    async deploy() { calls.push("deploy"); current = unit(NEW_IMAGE, "d".repeat(64)); return { containerName: "spawnfile-org", deployMs: 1 }; },
    async inspectUnit() { calls.push("inspect"); return current; },
    async notify() { return { channel: "command", delivered: true }; },
    async prune() { calls.push("prune"); return { kept: [], removed: [], skipped: [] }; },
    async lockDeployment() { calls.push("lock"); return async () => undefined; },
    async prepare(input) { return { authProfile: null, envFileEnv: input.envFileEnv }; },
    async runtimesOf() { calls.push("runtimes"); return options.running; },
    async requestDrain() { calls.push("drain"); return { drain: "draining", state: "paused" }; },
    async pinTarget() { return target; },
    async verifyTarget() { calls.push("verify-target"); },
    async requestResume() { calls.push("resume"); return { drain: null, state: "running" }; },
    async runPostDeploy() { return { exitCode: 0, output: "", timedOut: false }; },
    async settle() { calls.push("settle"); return current!; },
    async waitForDrained() { calls.push("wait"); return { drained: true, waitedMs: 1 }; }
  };
  return { calls, deps };
};

const drain = {
  async availability() { return { drain: "drained" as const, state: "paused" }; },
  async drain() { return { drain: "draining" as const, state: "paused" }; },
  async resume() { return { drain: null, state: "running" }; }
};
const mutating = ["prune", "build", "lock", "drain", "deploy", "resume"];

it("refuses a compiled image naming an absent adapter before pruning, building or draining", async () => {
  const h = harness({ compiled: ["absent-runtime"], running: ["absent-runtime"] });
  expect(await runRelease(request(), h.deps)).toMatchObject({
    kind: "failed", message: expect.stringMatching(/"absent-runtime".*--adapter <module>/u), reason: "blocked"
  });
  expect(h.calls.filter((call) => mutating.includes(call))).toEqual([]);
});

it("refuses to drain a running image whose adapter is absent, without touching it", async () => {
  const h = harness({ compiled: [SYNTHETIC], running: ["absent-runtime"] });
  const outcome = await withSyntheticAdapter(SYNTHETIC, () => runRelease(request(), h.deps), { operations: { drain } });
  expect(outcome).toMatchObject({ kind: "failed", message: expect.stringContaining("--adapter"), reason: "blocked" });
  expect(h.calls.filter((call) => mutating.includes(call))).toEqual([]);
});

it("keeps an interrupted drain marker when its runtime adapter is absent", async () => {
  const paths = resolveReleasePaths("org", root);
  await mkdir(paths.directory, { recursive: true });
  const marker = JSON.stringify({ container: "c".repeat(64), image: OLD_IMAGE, since: "x", target, version: "spawnfile.release-drain.v1" });
  await writeFile(paths.drainMarker, marker);
  const h = harness({ compiled: [SYNTHETIC], running: ["absent-runtime"] });
  expect(await runRelease(request(), h.deps)).toMatchObject({ kind: "failed", reason: "resume-failed" });
  await expect(readFile(paths.drainMarker, "utf8")).resolves.toBe(marker);
  expect(h.calls).not.toContain("compile");
  expect(h.calls.filter((call) => mutating.includes(call))).toEqual([]);
});

it("drains and releases a deployment whose adapter is loaded for this invocation", async () => {
  const h = harness({ compiled: [SYNTHETIC], running: [SYNTHETIC] });
  const outcome = await withSyntheticAdapter(SYNTHETIC, () => runRelease(request(), h.deps), { operations: { drain } });
  expect(outcome.kind).toBe("released");
  expect(h.calls.filter((call) => mutating.includes(call))).toEqual(["prune", "build", "lock", "drain", "deploy", "resume", "prune"]);
});
