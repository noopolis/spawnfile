import { describe, expect, it } from "vitest";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import {
  createBackedMountChecks,
  createBackedMountGuard,
  createBackedMountShellFunction,
  describeBackedMountRequirement,
  escapeMountInfoPath
} from "./containerBackedMountRender.js";

const execFile = promisify(execFileCallback);

describe("escapeMountInfoPath", () => {
  it("escapes exactly the four characters the kernel escapes", () => {
    // show_mountinfo passes " \t\n\\" to seq_path_root.
    expect(escapeMountInfoPath("/var/lib/my store")).toBe("/var/lib/my\\040store");
    expect(escapeMountInfoPath("/a\tb")).toBe("/a\\011b");
    expect(escapeMountInfoPath("/a\nb")).toBe("/a\\012b");
    expect(escapeMountInfoPath("/a\\b")).toBe("/a\\134b");
  });

  it("leaves an ordinary path byte-identical", () => {
    const plain = "/var/lib/spawnfile/moltnet/networks/clank-newsroom";
    expect(escapeMountInfoPath(plain)).toBe(plain);
  });
});

describe("createBackedMountChecks", () => {
  it("passes the mountinfo form for comparison and the real path for the message", () => {
    expect(createBackedMountChecks([
      { id: "store", mount_path: "/var/lib/my store", volume_name: "clank-store" }
    ])).toEqual([
      "require_backed_mount 'store' '/var/lib/my\\040store' '/var/lib/my store' 'clank-store'"
    ]);
  });

  it("deduplicates by path and orders deterministically", () => {
    expect(createBackedMountChecks([
      { id: "b", mount_path: "/b", volume_name: "vb" },
      { id: "a", mount_path: "/a", volume_name: "va" },
      { id: "b2", mount_path: "/b", volume_name: "vb" }
    ]).map((line) => line.split(" ")[1])).toEqual(["'a'", "'b'"]);
  });

  it("emits nothing at all when the compile declares no durable mounts", () => {
    expect(createBackedMountGuard([])).toEqual([]);
    expect(describeBackedMountRequirement([])).toBeNull();
  });

  it("counts distinct paths in the compile-time operator line", () => {
    expect(describeBackedMountRequirement([
      { id: "a", mount_path: "/a", volume_name: "va" },
      { id: "b", mount_path: "/a", volume_name: "va" }
    ])).toContain("1 durable mount ");
  });
});

// The guard reads /proc/self/mountinfo, so it can only be exercised on Linux.
describe("require_backed_mount against a real /proc/self/mountinfo", () => {
  it("accepts a mounted path with a space and rejects the same path unmounted", async () => {
    const volume = `spawnfile-backed-mount-${Date.now().toString(36)}`;
    // A space in the mount path is the case the kernel octal-escapes, and the
    // case a raw string compare reported as unbacked while it was mounted.
    const target = "/var/lib/my store";
    // Passed as one argv element, so the script's own quoting reaches bash
    // untouched and no host file needs to be bind-mounted in.
    const script = [
      "set -euo pipefail",
      ...createBackedMountShellFunction(),
      ...createBackedMountChecks([{ id: "edition", mount_path: target, volume_name: volume }]),
      "echo backed-ok"
    ].join("\n");
    try {
      await execFile("docker", ["volume", "create", volume]);
      const mounted = await execFile("docker", [
        "run", "--rm",
        "--mount", `type=volume,source=${volume},target=${target}`,
        "bash:5.2", "bash", "-c", script
      ], { timeout: 60_000 });
      expect(mounted.stdout).toContain("backed-ok");

      await expect(execFile("docker", [
        "run", "--rm", "bash:5.2", "bash", "-c", script
      ], { timeout: 60_000 })).rejects.toThrow(/is not backed by a volume at \/var\/lib\/my store/u);

      const optedOut = await execFile("docker", [
        "run", "--rm", "--env", "SPAWNFILE_ALLOW_EPHEMERAL_STATE=1",
        "bash:5.2", "bash", "-c", script
      ], { timeout: 60_000 });
      expect(optedOut.stdout).toContain("backed-ok");
    } finally {
      await execFile("docker", ["volume", "rm", "--force", volume]).catch(() => undefined);
    }
  }, 180_000);
});
