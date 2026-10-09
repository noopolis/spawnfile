import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { postDeployEnvironment, resolvePostDeployHook, runPostDeployCommand } from "./postDeploy.js";

const context = { containerName: "spawnfile-org", deployment: "org", identity: "sha256:abc", imageId: "sha256:img", imageTag: "spawnfile-org:r-abc" };

describe("post-deploy hook", () => {
  it("resolves only an absolute command, and arguments only with one", () => {
    expect(resolvePostDeployHook({ timeoutMs: 1 })).toBeNull();
    expect(resolvePostDeployHook({ postDeployArg: ["a"], postDeployCommand: "/bin/sh", timeoutMs: 5 })).toEqual({ args: ["a"], command: "/bin/sh", timeoutMs: 5 });
    expect(() => resolvePostDeployHook({ postDeployCommand: "sh", timeoutMs: 1 })).toThrow("absolute");
    expect(() => resolvePostDeployHook({ postDeployArg: ["a"], timeoutMs: 1 })).toThrow("needs --post-deploy-command");
    expect(() => resolvePostDeployHook({ postDeployCommand: "/bin/sh", timeoutMs: 25 * 3_600_000 })).toThrow("at most 24h");
  });

  it("names the release in the hook's environment", () => {
    expect(postDeployEnvironment(context, { KEEP: "1" })).toEqual({
      KEEP: "1", SPAWNFILE_RELEASE_CONTAINER: "spawnfile-org", SPAWNFILE_RELEASE_DEPLOYMENT: "org",
      SPAWNFILE_RELEASE_IDENTITY: "sha256:abc", SPAWNFILE_RELEASE_IMAGE: "spawnfile-org:r-abc", SPAWNFILE_RELEASE_IMAGE_ID: "sha256:img"
    });
  });

  it("runs without a shell, passes arguments verbatim and captures output", async () => {
    const result = await runPostDeployCommand(
      { args: ["-c", 'printf "%s|%s" "$1" "$SPAWNFILE_RELEASE_CONTAINER"; echo oops >&2; exit 4', "sh", "a b;c"], command: "/bin/sh", timeoutMs: 10_000 },
      context
    );
    expect(result).toMatchObject({ exitCode: 4, timedOut: false });
    expect(result.output).toContain("a b;c|spawnfile-org");
    expect(result.output).toContain("oops");
  });

  it("kills the hook's whole process group when it outlives its timeout", async () => {
    const started = Date.now();
    const result = await runPostDeployCommand({ args: ["-c", "sleep 30 & sleep 30"], command: "/bin/sh", timeoutMs: 100 }, context);
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("does not wait for a descendant that kept its output pipes after the hook exited", async () => {
    const started = Date.now();
    const result = await runPostDeployCommand({ args: ["-c", "(sleep 30 &); echo done"], command: "/bin/sh", timeoutMs: 20_000 }, context);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.output).toContain("done");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("never starts when the release was already interrupted", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "spawnfile-post-deploy-"));
    const marker = path.join(directory, "ran");
    try {
      const abort = new AbortController();
      abort.abort();
      await expect(runPostDeployCommand({ args: ["-c", `touch ${marker}`], command: "/bin/sh", timeoutMs: 1_000 }, context, abort.signal)).rejects.toThrow("aborted");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects a command that cannot be executed", async () => {
    await expect(runPostDeployCommand({ args: [], command: "/nonexistent/hook", timeoutMs: 1_000 }, context)).rejects.toThrow();
  });
});
