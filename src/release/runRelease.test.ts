import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DrainWait } from "./drainControl.js";
import { resolveReleasePaths, type ReleaseLedger } from "./ledger.js";
import type { RunningUnit } from "./releaseDocker.js";
import type { ReleaseDependencies, ReleaseRequest } from "./releaseTypes.js";
import { runRelease } from "./runRelease.js";
import { ReleaseError, releaseExitCode } from "./types.js";

const IDENTITY = `sha256:${"a".repeat(64)}`;
const OLD_IDENTITY = `sha256:${"b".repeat(64)}`;
const OLD_IMAGE = `sha256:${"1".repeat(64)}`;
const NEW_IMAGE = `sha256:${"2".repeat(64)}`;

let root: string;
const roots: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-release-"));
  roots.push(root);
  vi.stubEnv("SPAWNFILE_DAIMON_CONTROL_TOKEN", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

const unit = (imageId: string, id = "c".repeat(64)): RunningUnit => ({ health: "healthy", id, imageId, restartCount: 0, running: true });

const request = (overrides: Partial<ReleaseRequest> = {}): ReleaseRequest => ({
  bundleIdentity: "release",
  deployment: "org",
  dockerCommand: "docker",
  drain: true,
  drainPollMs: 1,
  drainTimeoutMs: 1_000,
  envFileEnv: { SPAWNFILE_DAIMON_CONTROL_TOKEN: "secret-token" },
  force: false,
  inputPath: "/project",
  log: () => undefined,
  notifier: { command: "/bin/notify", kind: "command" },
  notifyDeferredAfterMs: 24 * 3_600_000,
  releaseRoot: root,
  settle: { pollMs: 1, polls: 3, stablePolls: 2 },
  ...overrides
});

interface Harness {
  calls: string[];
  deps: ReleaseDependencies;
  notifications: string[];
}

const harness = (options: {
  running?: RunningUnit | null;
  wait?: DrainWait;
  failAt?: Partial<Record<"build" | "deploy" | "drain" | "settle", Error>>;
  runtimes?: string[];
  swapDuringDrain?: boolean;
} = {}): Harness => {
  const calls: string[] = [];
  const notifications: string[] = [];
  let current: RunningUnit | null = options.running === undefined ? unit(OLD_IMAGE) : options.running;
  const deps: ReleaseDependencies = {
    async build(_request, _compiled, imageTag) {
      calls.push(`build ${imageTag}`);
      if (options.failAt?.build) throw options.failAt.build;
      return { buildMs: 10, imageId: NEW_IMAGE, imageTag, skipped: false };
    },
    async compile() {
      calls.push("compile");
      return { compileMs: 5, compileResult: { report: { compile_fingerprint: "sf1:x" } } as never, identity: IDENTITY, repository: "spawnfile-org" };
    },
    async deploy(_request, imageTag) {
      calls.push(`deploy ${imageTag}`);
      if (options.failAt?.deploy) throw options.failAt.deploy;
      current = unit(NEW_IMAGE, "d".repeat(64));
      return { containerName: "spawnfile-org", deployMs: 20 };
    },
    async inspectUnit(_request, ref) { calls.push(`inspect ${ref.slice(0, 14)}`); return current; },
    async notify(_config, notification) { notifications.push(notification.reason); calls.push(`notify ${notification.reason}`); return { channel: "command", delivered: true }; },
    async prune(_request, repository, keep) { calls.push(`prune ${keep.filter(Boolean).join(",")}`); return { kept: [], removed: [], skipped: [] }; },
    async lockDeployment() { calls.push("lock"); return async () => { calls.push("unlock"); }; },
    async prepare(request) { return { authProfile: null, envFileEnv: request.envFileEnv }; },
    async runtimesOf() { calls.push("runtimes"); return options.runtimes ?? ["daimon"]; },
    async requestDrain(target) {
      calls.push(`drain ${target.containerRef.slice(0, 1)}`);
      if (options.failAt?.drain) throw options.failAt.drain;
      return { drain: "draining", state: "paused" };
    },
    async resolveTarget() { return { endpoint_fingerprint: "sha256:local", kind: "context", name: "default" }; },
    async verifyTarget() { calls.push("verify-target"); },
    async requestResume(target) { calls.push(`resume ${target.containerRef.slice(0, 1)}`); return { drain: null, state: "running" }; },
    async settle() { calls.push("settle"); if (options.failAt?.settle) throw options.failAt.settle; return current!; },
    async waitForDrained() {
      calls.push("wait");
      if (options.swapDuringDrain) current = { ...current!, restartCount: current!.restartCount + 1 };
      return options.wait ?? { drained: true, waitedMs: 3 };
    }
  };
  return { calls, deps, notifications };
};

const writeLedger = async (ledger: Partial<ReleaseLedger>): Promise<void> => {
  const paths = resolveReleasePaths("org", root);
  await rm(paths.directory, { force: true, recursive: true });
  await import("node:fs/promises").then((fs) => fs.mkdir(paths.directory, { recursive: true }));
  await writeFile(paths.ledger, JSON.stringify({
    compile_fingerprint: "sf1:x", deployment: "org", identity: OLD_IDENTITY, image_id: OLD_IMAGE,
    image_tag: "spawnfile-org:r-bbbbbbbbbbbb", previous_image_tag: null, released_at: "2026-10-08T00:00:00.000Z",
    timings: { build_ms: 1, compile_ms: 1, deploy_ms: 1, drain_ms: 1, total_ms: 1 }, version: "spawnfile.release-ledger.v1",
    ...ledger
  }));
};

describe("runRelease", () => {
  it("drains before it deploys, settles, resumes, records and prunes, in that order", async () => {
    await writeLedger({});
    const h = harness();
    const outcome = await runRelease(request(), h.deps);
    expect(outcome.kind).toBe("released");
    expect(h.calls).toEqual([
      "compile", "inspect spawnfile-org", "prune spawnfile-org:r-aaaaaaaaaaaa,spawnfile-org:r-bbbbbbbbbbbb",
      "build spawnfile-org:r-aaaaaaaaaaaa", "lock", "inspect spawnfile-org", "runtimes", "drain c", "wait", "inspect spawnfile-org",
      "deploy spawnfile-org:r-aaaaaaaaaaaa", "settle", "resume d",
      "prune spawnfile-org:r-aaaaaaaaaaaa,spawnfile-org:r-bbbbbbbbbbbb", "unlock"
    ]);
    const ledger = JSON.parse(await readFile(resolveReleasePaths("org", root).ledger, "utf8")) as ReleaseLedger;
    expect(ledger).toMatchObject({ identity: IDENTITY, image_id: NEW_IMAGE, image_tag: "spawnfile-org:r-aaaaaaaaaaaa", previous_image_tag: "spawnfile-org:r-bbbbbbbbbbbb" });
    expect(ledger.timings).toMatchObject({ build_ms: 10, compile_ms: 5, deploy_ms: 20 });
  });

  it("does nothing at all when the recorded identity is the one running", async () => {
    await writeLedger({ identity: IDENTITY, image_id: OLD_IMAGE });
    const h = harness();
    const outcome = await runRelease(request(), h.deps);
    expect(outcome).toMatchObject({ kind: "unchanged" });
    expect(releaseExitCode(outcome)).toBe(0);
    expect(h.calls).toEqual(["compile", "inspect spawnfile-org"]);
  });

  it("releases an unchanged identity when the running container is not the recorded image", async () => {
    await writeLedger({ identity: IDENTITY, image_id: OLD_IMAGE });
    const h = harness({ running: unit(`sha256:${"9".repeat(64)}`) });
    expect((await runRelease(request(), h.deps)).kind).toBe("released");
  });

  it("releases an unchanged identity with --force", async () => {
    await writeLedger({ identity: IDENTITY, image_id: OLD_IMAGE });
    const h = harness();
    expect((await runRelease(request({ force: true }), h.deps)).kind).toBe("released");
  });

  it("on a drain timeout resumes admission and never deploys", async () => {
    const h = harness({ wait: { drained: false, reason: "timeout", waitedMs: 1_000 } });
    const outcome = await runRelease(request(), h.deps);
    expect(outcome.kind).toBe("deferred");
    expect(releaseExitCode(outcome)).toBe(75);
    expect(h.calls.some((call) => call.startsWith("deploy"))).toBe(false);
    expect(h.calls.slice(-3)).toEqual(["wait", "resume c", "unlock"]);
    expect(h.notifications).toEqual([]);
    await expect(readFile(resolveReleasePaths("org", root).ledger, "utf8")).rejects.toThrow();
  });

  it("notifies a deferral once it has waited past the threshold, and only once", async () => {
    let now = new Date("2026-10-08T00:00:00.000Z");
    const req = request({ now: () => now });
    const h = harness({ wait: { drained: false, reason: "timeout", waitedMs: 1_000 } });
    await runRelease(req, h.deps);
    now = new Date("2026-10-09T01:00:00.000Z");
    expect(await runRelease(req, h.deps)).toMatchObject({ kind: "deferred", notified: true });
    now = new Date("2026-10-09T02:00:00.000Z");
    expect(await runRelease(req, h.deps)).toMatchObject({ kind: "deferred", notified: false });
    expect(h.notifications).toEqual(["release-deferred"]);
  });

  it("resumes and notifies when the drain request itself fails, without deploying", async () => {
    const h = harness({ failAt: { drain: new ReleaseError("drain-failed", "no /v2/drain route") } });
    const outcome = await runRelease(request(), h.deps);
    expect(outcome).toMatchObject({ kind: "failed", reason: "drain-failed" });
    expect(h.calls).toContain("resume c");
    expect(h.calls.some((call) => call.startsWith("deploy"))).toBe(false);
    expect(h.notifications).toEqual(["drain-failed"]);
  });

  it("resumes whatever holds the name after a failed deploy and records nothing", async () => {
    const h = harness({ failAt: { deploy: new Error("candidate did not become ready") } });
    const outcome = await runRelease(request(), h.deps);
    expect(outcome).toMatchObject({ kind: "failed", reason: "deploy-failed" });
    expect(h.calls.slice(-4)).toEqual(["inspect spawnfile-org", "resume c", "unlock", "notify deploy-failed"]);
    await expect(readFile(resolveReleasePaths("org", root).ledger, "utf8")).rejects.toThrow();
  });

  it("does not record a release whose container never settles", async () => {
    const h = harness({ failAt: { settle: new ReleaseError("health-failed", "restarting") } });
    expect(await runRelease(request(), h.deps)).toMatchObject({ kind: "failed", reason: "health-failed" });
    await expect(readFile(resolveReleasePaths("org", root).ledger, "utf8")).rejects.toThrow();
  });

  it("reports a failed build as build-failed before anything is paused", async () => {
    const h = harness({ failAt: { build: new Error("docker build exited 1") } });
    expect(await runRelease(request(), h.deps)).toMatchObject({ kind: "failed", reason: "build-failed" });
    expect(h.calls.some((call) => call.startsWith("drain"))).toBe(false);
  });

  it("refuses a ledger it cannot read before building anything", async () => {
    const paths = resolveReleasePaths("org", root);
    await import("node:fs/promises").then((fs) => fs.mkdir(paths.directory, { recursive: true }));
    await writeFile(paths.ledger, "{not json");
    const h = harness();
    expect(await runRelease(request(), h.deps)).toMatchObject({ kind: "failed", reason: "blocked" });
    expect(h.calls).toEqual(["compile", "notify blocked"]);
  });

  it("refuses before building when it would have to drain without a control token", async () => {
    const h = harness();
    expect(await runRelease(request({ envFileEnv: {} }), h.deps)).toMatchObject({ kind: "failed", reason: "blocked" });
    expect(h.calls.some((call) => call.startsWith("build"))).toBe(false);
  });

  it("deploys without draining when nothing is running", async () => {
    const h = harness({ running: null });
    expect((await runRelease(request({ envFileEnv: {} , drain: false }), h.deps)).kind).toBe("released");
    expect(h.calls.some((call) => call.startsWith("drain"))).toBe(false);
  });

  it("skips the drain entirely with --no-drain", async () => {
    const h = harness();
    expect((await runRelease(request({ drain: false }), h.deps)).kind).toBe("released");
    expect(h.calls.filter((call) => call.startsWith("drain") || call.startsWith("resume"))).toEqual([]);
  });

  it("resumes and stops when interrupted while waiting for turns", async () => {
    const h = harness({ wait: { drained: false, reason: "interrupted", waitedMs: 1 } });
    expect(await runRelease(request(), h.deps)).toMatchObject({ kind: "failed", reason: "interrupted" });
    expect(h.calls).toContain("resume c");
    expect(h.calls.some((call) => call.startsWith("deploy"))).toBe(false);
  });

  it("resumes an organization an interrupted release left drained, before anything else", async () => {
    const paths = resolveReleasePaths("org", root);
    await import("node:fs/promises").then((fs) => fs.mkdir(paths.directory, { recursive: true }));
    await writeFile(paths.drainMarker, JSON.stringify({ container: "c".repeat(64), image: OLD_IMAGE, since: "x", target: { "endpoint_fingerprint": "sha256:local", "kind": "context", "name": "default" }, version: "spawnfile.release-drain.v1" }));
    await writeLedger({ identity: IDENTITY, image_id: OLD_IMAGE });
    await writeFile(paths.drainMarker, JSON.stringify({ container: "c".repeat(64), image: OLD_IMAGE, since: "x", target: { "endpoint_fingerprint": "sha256:local", "kind": "context", "name": "default" }, version: "spawnfile.release-drain.v1" }));
    const h = harness();
    expect((await runRelease(request(), h.deps)).kind).toBe("unchanged");
    expect(h.calls.slice(0, 4)).toEqual(["verify-target", "inspect cccccccccccccc", "resume c", "compile"]);
    await expect(readFile(paths.drainMarker, "utf8")).rejects.toThrow();
  });

  it("refuses to drain a container that also runs runtimes without a drain contract", async () => {
    const h = harness({ runtimes: ["daimon", "openclaw"] });
    expect(await runRelease(request(), h.deps)).toMatchObject({ kind: "failed", reason: "blocked", message: expect.stringContaining("openclaw") });
    expect(h.calls.some((call) => call.startsWith("drain") || call.startsWith("deploy"))).toBe(false);
    expect(h.calls).toContain("unlock");
  });

  it("aborts and resumes when the drained container restarted before the deploy", async () => {
    const h = harness({ swapDuringDrain: true });
    expect(await runRelease(request(), h.deps)).toMatchObject({ kind: "failed", reason: "drain-failed" });
    expect(h.calls.some((call) => call.startsWith("deploy"))).toBe(false);
    expect(h.calls).toContain("resume c");
  });

  it("re-notifies a deferral whose notification was not delivered", async () => {
    let now = new Date("2026-10-08T00:00:00.000Z");
    const req = request({ now: () => now });
    const h = harness({ wait: { drained: false, reason: "timeout", waitedMs: 1_000 } });
    let deliver = false;
    h.deps.notify = async (_config, notification) => { h.notifications.push(notification.reason); return { channel: "command", delivered: deliver }; };
    await runRelease(req, h.deps);
    now = new Date("2026-10-09T01:00:00.000Z");
    expect(await runRelease(req, h.deps)).toMatchObject({ notified: false });
    deliver = true;
    now = new Date("2026-10-09T02:00:00.000Z");
    expect(await runRelease(req, h.deps)).toMatchObject({ notified: true });
    now = new Date("2026-10-09T03:00:00.000Z");
    expect(await runRelease(req, h.deps)).toMatchObject({ notified: false });
    expect(h.notifications).toEqual(["release-deferred", "release-deferred"]);
  });

  it("reports an unreadable env file through the notifier", async () => {
    const h = harness();
    h.deps.prepare = async () => { throw new Error("ENOENT: /etc/org.env"); };
    expect(await runRelease(request(), h.deps)).toMatchObject({ kind: "failed", reason: "blocked", message: expect.stringContaining("prepare") });
    expect(h.notifications).toEqual(["blocked"]);
  });

  it("does not deploy when interrupted while a drained answer was in flight", async () => {
    const abort = new AbortController();
    const h = harness();
    h.deps.waitForDrained = async () => { h.calls.push("wait"); abort.abort(); return { drained: true, waitedMs: 1 }; };
    expect(await runRelease(request({ signal: abort.signal }), h.deps)).toMatchObject({ kind: "failed", reason: "interrupted" });
    expect(h.calls).toContain("resume c");
    expect(h.calls.some((call) => call.startsWith("deploy"))).toBe(false);
  });

  it("normalizes the deployment name before naming the container it drains", async () => {
    const h = harness();
    expect((await runRelease(request({ deployment: " org " }), h.deps)).kind).toBe("released");
    expect(h.calls).toContain("drain c");
    expect(h.calls.filter((call) => call.startsWith("inspect"))).toEqual(Array(3).fill("inspect spawnfile-org"));
  });

  it("does not record an image other than the one it built", async () => {
    const h = harness();
    h.deps.settle = async () => unit(`sha256:${"7".repeat(64)}`, "d".repeat(64));
    expect(await runRelease(request(), h.deps)).toMatchObject({ kind: "failed", reason: "deploy-failed" });
    await expect(readFile(resolveReleasePaths("org", root).ledger, "utf8")).rejects.toThrow();
    expect(h.calls.at(-2)).toBe("unlock");
  });

  it("resumes the drained container when it cannot be confirmed before the deploy", async () => {
    const h = harness();
    let inspections = 0;
    const inspect = h.deps.inspectUnit;
    h.deps.inspectUnit = async (req, ref) => { inspections += 1; if (inspections === 3) throw new Error("docker hiccup"); return inspect(req, ref); };
    expect(await runRelease(request(), h.deps)).toMatchObject({ kind: "failed", reason: "drain-failed" });
    expect(h.calls).toContain("resume c");
    expect(h.calls.some((call) => call.startsWith("deploy"))).toBe(false);
  });

  it("refuses to run beside another live release of the same deployment", async () => {
    const paths = resolveReleasePaths("org", root);
    await import("node:fs/promises").then((fs) => fs.mkdir(paths.directory, { recursive: true }));
    await writeFile(paths.lock, JSON.stringify({ pid: process.pid }));
    const h = harness();
    expect(await runRelease(request(), h.deps)).toMatchObject({ kind: "failed", reason: "blocked" });
    expect(h.calls).toEqual(["notify blocked"]);
  });
});
