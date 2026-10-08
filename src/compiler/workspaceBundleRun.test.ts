import { describe, expect, it } from "vitest";

import { containerArgv, runBundleCommand } from "./workspaceBundleRun.js";

describe("bundle build steps", () => {
  it("renders a removed, target-platform, host-uid container run with a throwaway HOME", () => {
    const argv = containerArgv({
      argv: ["npm", "ci"], dockerCommand: "docker", env: { B: "2", A: "1" }, image: `node@sha256:${"a".repeat(64)}`,
      mounts: [["/host/work", "/spawnfile/work"]], network: false, platform: "linux/arm64", workdir: "/spawnfile/work"
    });
    expect(argv.slice(0, 5)).toEqual(["docker", "run", "--rm", "--platform", "linux/arm64"]);
    expect(argv).toEqual(expect.arrayContaining(["--network", "none", "--volume", "/host/work:/spawnfile/work", "--workdir", "/spawnfile/work"]));
    expect(argv.slice(-9)).toEqual(["--env", "A=1", "--env", "B=2", "--env", "HOME=/tmp/spawnfile-home", `node@sha256:${"a".repeat(64)}`, "npm", "ci"]);
    expect(argv.indexOf("A=1")).toBeLessThan(argv.indexOf("B=2"));
    expect(argv.slice(-2)).toEqual(["npm", "ci"]);
  });

  it("returns stdout and reports exit codes, stderr tails, timeouts and missing programs", async () => {
    await expect(runBundleCommand({ argv: ["sh", "-c", "printf ok"], cwd: process.cwd(), timeoutMs: 10_000 }, "step")).resolves.toBe("ok");
    await expect(runBundleCommand({ argv: ["sh", "-c", "echo bad >&2; exit 2"], cwd: process.cwd(), timeoutMs: 10_000 }, "step")).rejects.toThrow(/step exited 2: bad/u);
    await expect(runBundleCommand({ argv: ["sleep", "5"], cwd: process.cwd(), timeoutMs: 200 }, "step")).rejects.toThrow(/timed out after 200 ms/u);
    await expect(runBundleCommand({ argv: ["spawnfile-no-such-program"], cwd: process.cwd(), timeoutMs: 1_000 }, "step")).rejects.toThrow(/could not start/u);
  });
});
