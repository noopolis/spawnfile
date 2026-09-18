import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { MOUNT_AWARE_CLEAR_HELPER } from "../../containerDaimonBrokerRender.js";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/**
 * Exercises the rendered shell itself against a real tree, with the mount table
 * injected instead of read from `/proc` — the helper's only input, and the only
 * part of it a developer machine cannot produce. `bash` on macOS is `sh`-level
 * POSIX here, which is exactly what the container's `bash --noprofile --norc`
 * runs the script as.
 */
const exercise = async (root: string, mounts: readonly string[], command: string): Promise<{ stdout: string; stderr: string }> => {
  const script = [
    // Single quotes keep the real newlines; `JSON.stringify` would hand bash a literal backslash-n.
    ...MOUNT_AWARE_CLEAR_HELPER.map(line => line.replace("spawnfile_mount_points=$(awk '{print $5}' /proc/self/mountinfo)",
      `spawnfile_mount_points='${mounts.join("\n")}'`)),
    command
  ].join("\n");
  return run("/bin/bash", ["--noprofile", "--norc", "-ceu", script], { cwd: root });
};

const tree = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mount-aware-clear-")));
  roots.push(root);
  await mkdir(path.join(root, "target/keep-me"), { recursive: true });
  await mkdir(path.join(root, "target/plain"), { recursive: true });
  await writeFile(path.join(root, "target/plain/file"), "x");
  await writeFile(path.join(root, "target/loose"), "x");
  return root;
};

describe("mount-aware clear", () => {
  it("empties a tree that holds no mount point", async () => {
    const root = await tree();
    await exercise(root, [], `spawnfile_clear_tree ${JSON.stringify(path.join(root, "target"))}`);
    expect(await readdir(path.join(root, "target"))).toEqual([]);
  });

  it("keeps a mount point and still clears everything around it", async () => {
    const root = await tree();
    const mount = path.join(root, "target/keep-me");
    await writeFile(path.join(mount, "owned-by-the-mount"), "x");
    await exercise(root, [root, mount], `spawnfile_clear_tree ${JSON.stringify(path.join(root, "target"))}`);
    expect(await readdir(path.join(root, "target"))).toEqual(["keep-me"]);
    // Its contents belong to the other filesystem and are never touched either.
    expect(await readdir(mount)).toEqual(["owned-by-the-mount"]);
  });

  it("descends into a directory that merely contains a mount point, instead of removing it", async () => {
    const root = await tree();
    const mount = path.join(root, "target/plain/nested-mount");
    await mkdir(mount);
    await exercise(root, [root, mount], `spawnfile_clear_tree ${JSON.stringify(path.join(root, "target"))}`);
    expect(await readdir(path.join(root, "target"))).toEqual(["plain"]);
    expect(await readdir(path.join(root, "target/plain"))).toEqual(["nested-mount"]);
  });

  it("removes a whole target that holds no mount point", async () => {
    const root = await tree();
    await exercise(root, [], `spawnfile_remove_tree ${JSON.stringify(path.join(root, "target"))}`);
    expect(await readdir(root)).toEqual([]);
  });

  it("clears rather than removes a target that is itself a mount point", async () => {
    const root = await tree();
    const target = path.join(root, "target");
    await exercise(root, [root, target], `spawnfile_remove_tree ${JSON.stringify(target)}`);
    expect(await readdir(target)).toEqual([]);
  });

  it("is a no-op for an absent target", async () => {
    const root = await tree();
    await exercise(root, [], `spawnfile_remove_tree ${JSON.stringify(path.join(root, "absent"))}`);
    await exercise(root, [], `spawnfile_clear_tree ${JSON.stringify(path.join(root, "absent"))}`);
  });

  it("names the path it could not clear instead of failing on a bare find or rm", async () => {
    const root = await tree();
    // A path the shell cannot remove stands in for a busy mount the table did not list.
    const script = `spawnfile_clear_tree() { echo "cannot clear $1/busy: it is in use" >&2; return 1; }\nspawnfile_clear_tree ${JSON.stringify(root)}`;
    await expect(run("/bin/bash", ["--noprofile", "--norc", "-ceu", script])).rejects.toMatchObject({
      stderr: expect.stringContaining("cannot clear") as unknown as string
    });
  });
});
