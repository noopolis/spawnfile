import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReleaseDependencies, ReleaseOutcome, ReleaseRequest } from "../release/index.js";

import { parseReleaseDuration, registerReleaseCommand } from "./releaseCommand.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "spawnfile-release-cli-"));
  vi.stubEnv("SPAWNFILE_HOME", home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { force: true, recursive: true });
});

describe("parseReleaseDuration", () => {
  it("reads explicit units and refuses a bare or zero number", () => {
    expect(parseReleaseDuration("90s", "--x")).toBe(90_000);
    expect(parseReleaseDuration("30m", "--x")).toBe(1_800_000);
    expect(parseReleaseDuration("2h", "--x")).toBe(7_200_000);
    expect(parseReleaseDuration("500ms", "--x")).toBe(500);
    expect(() => parseReleaseDuration("30", "--x")).toThrow("duration");
    expect(() => parseReleaseDuration("0s", "--x")).toThrow("positive");
  });
});

const run = async (argv: string[], outcome: Partial<ReleaseOutcome> | Error) => {
  const program = new Command();
  program.exitOverride();
  let exitCode = -1;
  let seen: ReleaseRequest | null = null;
  const lines: string[] = [];
  const failing = (): never => { throw outcome instanceof Error ? outcome : new Error("compile exploded"); };
  const deps = {
    compile: async (request: ReleaseRequest) => { seen = request; return failing(); },
    notify: async () => ({ channel: "command", delivered: true }),
    prepare: async (request: ReleaseRequest) => ({ authProfile: null, envFileEnv: request.envFileEnv })
  } as unknown as ReleaseDependencies;
  registerReleaseCommand(program, { stderr: (line) => lines.push(line), stdout: (line) => lines.push(line) }, (code) => { exitCode = code; }, () => deps);
  await program.parseAsync(["release", ...argv], { from: "user" });
  return { exitCode, lines, seen: seen as ReleaseRequest | null };
};

describe("spawnfile release", () => {
  it("maps the release request from its flags and exits 1 on a failed release", async () => {
    const result = await run([
      "/project", "--deployment", "org", "--drain-timeout", "45m", "--notify-command", "/usr/bin/true",
      "--context", "prod", "--image-repository", "acme/org", "--dev-inputs", "--force", "--no-drain", "--out", "/tmp/out"
    ], new Error("nope"));
    expect(result.exitCode).toBe(1);
    expect(result.seen).toMatchObject({
      bundleIdentity: "dev", deployment: "org", dockerContext: "prod", drain: false, drainTimeoutMs: 2_700_000, force: true,
      imageRepository: "acme/org", inputPath: "/project", notifier: { command: "/usr/bin/true", kind: "command" },
      notifyDeferredAfterMs: 86_400_000, outputDirectory: "/tmp/out"
    });
    expect(result.lines.some((line) => line.includes("release FAILED: build-failed"))).toBe(true);
  });

  it("defaults to a drained release from committed inputs", async () => {
    const result = await run(["/project", "--deployment", "org"], new Error("x"));
    expect(result.seen).toMatchObject({ bundleIdentity: "release", drain: true, drainTimeoutMs: 1_800_000, notifier: { kind: "none" } });
  });

  it("rejects two notifiers and a relative command before doing anything", async () => {
    await expect(run(["/p", "--deployment", "org", "--notify-command", "/a", "--notify-webhook-env", "B"], new Error("x"))).rejects.toThrow("one notifier");
    await expect(run(["/p", "--deployment", "org", "--notify-command", "page"], new Error("x"))).rejects.toThrow("absolute");
  });

  it("requires a deployment", async () => {
    await expect(run(["/p"], new Error("x"))).rejects.toThrow();
  });
});
