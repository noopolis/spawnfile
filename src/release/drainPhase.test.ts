import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { controlTargetFor, recoverInterruptedDrain, resolveControlToken, resumeAfterFailedDeploy } from "./drainPhase.js";
import { ensureReleaseDirectory, resolveReleasePaths, type ReleasePaths } from "./ledger.js";
import type { RunningUnit } from "./releaseDocker.js";
import type { RuntimeControlTarget } from "./drainControl.js";
import type { ReleaseDependencies, ReleaseRequest } from "./releaseTypes.js";

let root: string;
let paths: ReleasePaths;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-drain-phase-"));
  paths = resolveReleasePaths("org", root);
  await ensureReleaseDirectory(paths);
  vi.stubEnv("SPAWNFILE_DAIMON_CONTROL_TOKEN", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { force: true, recursive: true });
});

const request = (envFileEnv: Record<string, string> = { SPAWNFILE_DAIMON_CONTROL_TOKEN: "file-token" }): ReleaseRequest => ({
  bundleIdentity: "release", deployment: "org", dockerCommand: "docker", dockerContext: "prod", drain: true, drainPollMs: 1, drainTimeoutMs: 1,
  envFileEnv, force: false, inputPath: "/p", log: () => undefined, notifier: { kind: "none" }, notifyDeferredAfterMs: 1,
  releaseRoot: root, settle: { pollMs: 1, polls: 1, stablePolls: 1 }
});

const deps = (unit: RunningUnit | null, resume: () => Promise<void> = async () => undefined): ReleaseDependencies & { resumed: string[] } => {
  const resumed: string[] = [];
  return {
    resumed,
    inspectUnit: async () => unit,
    pinTarget: async () => LOCAL,
    verifyTarget: async () => undefined,
    requestResume: async (target: RuntimeControlTarget) => { resumed.push(target.containerRef); await resume(); return { drain: null, state: "running" }; }
  } as unknown as ReleaseDependencies & { resumed: string[] };
};

const running: RunningUnit = { health: "healthy", id: "c1", imageId: "sha256:img", restartCount: 0, running: true };
const LOCAL = { endpoint_fingerprint: "sha256:local", kind: "context", name: "default" } as const;
const marker = JSON.stringify({ container: "c1", image: "sha256:img", since: "t", target: LOCAL, version: "spawnfile.release-drain.v1" });

describe("control token", () => {
  it("prefers the process environment over the env file, like up does", () => {
    expect(resolveControlToken(request())).toBe("file-token");
    vi.stubEnv("SPAWNFILE_DAIMON_CONTROL_TOKEN", "process-token");
    expect(resolveControlToken(request())).toBe("process-token");
    expect(controlTargetFor(request(), "c1", "img")).toMatchObject({ dockerArgs: ["--context", "prod"], token: "process-token" });
  });

  it("refuses to build a control target without a token", () => {
    expect(() => controlTargetFor(request({}), "c1", "img")).toThrow("SPAWNFILE_DAIMON_CONTROL_TOKEN");
  });
});

describe("recoverInterruptedDrain", () => {
  it("does nothing without a marker", async () => {
    const d = deps(running);
    expect(await recoverInterruptedDrain(request(), d, paths)).toBe(false);
    expect(d.resumed).toEqual([]);
  });

  it("resumes the container a killed release left drained", async () => {
    await writeFile(paths.drainMarker, marker);
    const d = deps(running);
    expect(await recoverInterruptedDrain(request(), d, paths)).toBe(true);
    expect(d.resumed).toEqual(["c1"]);
    await expect(readFile(paths.drainMarker)).rejects.toThrow();
  });

  it("clears the marker without calling anything when that container is gone or stopped", async () => {
    await writeFile(paths.drainMarker, marker);
    const d = deps({ ...running, running: false });
    expect(await recoverInterruptedDrain(request(), d, paths)).toBe(true);
    expect(d.resumed).toEqual([]);
    await expect(readFile(paths.drainMarker)).rejects.toThrow();
  });

  it("keeps the marker and fails loudly when the resume does not work", async () => {
    await writeFile(paths.drainMarker, marker);
    const d = deps(running, async () => { throw new Error("401"); });
    await expect(recoverInterruptedDrain(request(), d, paths)).rejects.toMatchObject({ reason: "resume-failed" });
    expect(await readFile(paths.drainMarker, "utf8")).toBe(marker);
  });

  it("recovers through the Docker daemon the drain went out through, not this run's", async () => {
    const remote = { endpoint_fingerprint: "sha256:remote", kind: "context", name: "remote" } as const;
    await writeFile(paths.drainMarker, JSON.stringify({ container: "c1", image: "sha256:img", since: "t", target: remote, version: "spawnfile.release-drain.v1" }));
    const contexts: (string | undefined)[] = [];
    const d = deps(running);
    d.inspectUnit = async (req) => { contexts.push(req.dockerContext); return running; };
    const resumedArgs: string[][] = [];
    d.requestResume = async (target) => { resumedArgs.push([...target.dockerArgs]); return { drain: null, state: "running" }; };
    await recoverInterruptedDrain(request(), d, paths);
    expect(contexts).toEqual(["remote"]);
    expect(resumedArgs).toEqual([["--context", "remote"]]);
  });

  it("reaches a DOCKER_HOST target with --host", async () => {
    await writeFile(paths.drainMarker, JSON.stringify({ container: "c1", image: "sha256:img", since: "t", target: { kind: "host", value: "ssh://ops@box" }, version: "spawnfile.release-drain.v1" }));
    const d = deps(running);
    const resumedArgs: string[][] = [];
    d.requestResume = async (target) => { resumedArgs.push([...target.dockerArgs]); return { drain: null, state: "running" }; };
    await recoverInterruptedDrain(request(), d, paths);
    expect(resumedArgs).toEqual([["--host", "ssh://ops@box"]]);
  });

  it("keeps the marker when the recorded daemon's endpoint changed", async () => {
    await writeFile(paths.drainMarker, marker);
    const d = deps(running);
    d.verifyTarget = async () => { throw new Error("endpoint changed since deployment"); };
    await expect(recoverInterruptedDrain(request(), d, paths)).rejects.toMatchObject({ reason: "resume-failed" });
    expect(await readFile(paths.drainMarker, "utf8")).toBe(marker);
    expect(d.resumed).toEqual([]);
  });

  it("keeps the marker when the marked container cannot be inspected", async () => {
    await writeFile(paths.drainMarker, marker);
    const d = deps(running);
    d.inspectUnit = async () => { throw new Error("docker unreachable"); };
    await expect(recoverInterruptedDrain(request(), d, paths)).rejects.toMatchObject({ reason: "resume-failed" });
    expect(await readFile(paths.drainMarker, "utf8")).toBe(marker);
  });

  it("treats an unreadable marker as a possibly drained organization", async () => {
    await import("node:fs/promises").then((fs) => fs.mkdir(paths.drainMarker));
    await expect(recoverInterruptedDrain(request(), deps(running), paths)).rejects.toMatchObject({ reason: "resume-failed" });
  });
});

describe("resumeAfterFailedDeploy", () => {
  it("resumes whatever container holds the name", async () => {
    await writeFile(paths.drainMarker, marker);
    const d = deps(running);
    await resumeAfterFailedDeploy(request(), d, paths, "spawnfile-org");
    expect(d.resumed).toEqual(["c1"]);
    await expect(readFile(paths.drainMarker)).rejects.toThrow();
  });

  it("keeps the marker when the container cannot be inspected after a failed deploy", async () => {
    await writeFile(paths.drainMarker, marker);
    const d = deps(running);
    d.inspectUnit = async () => { throw new Error("docker unreachable"); };
    await expect(resumeAfterFailedDeploy(request(), d, paths, "spawnfile-org")).rejects.toMatchObject({ reason: "resume-failed" });
    expect(await readFile(paths.drainMarker, "utf8")).toBe(marker);
  });

  it("only clears the marker when nothing is running", async () => {
    await writeFile(paths.drainMarker, marker);
    const d = deps(null);
    await resumeAfterFailedDeploy(request(), d, paths, "spawnfile-org");
    expect(d.resumed).toEqual([]);
    await expect(readFile(paths.drainMarker)).rejects.toThrow();
  });
});
