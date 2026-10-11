import { lstat, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { gitTestRoot } from "./git.test-helper.js";
import { restoreInspectedAccessTimes, snapshotBundleFiles } from "./leakFiles.js";
import { restoreAccessTimes, stampTree } from "./timestamps.js";

const roots: string[] = [], old = "1960-01-01T00:00:00Z", at = "2026-10-09T08:20:31Z";
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it.each(["inspection", "materializer"])("preserves negative file, link and directory epochs during %s restoration", async (helper) => {
  const root = await gitTestRoot(); roots.push(root);
  await writeFile(path.join(root, "data"), "past"); await symlink("data", path.join(root, "link"));
  await stampTree(root, old, at);
  const files = await snapshotBundleFiles(root);
  await readFile(path.join(root, "data")); await readdir(root);
  if (helper === "inspection") await restoreInspectedAccessTimes(files);
  else await restoreAccessTimes(root, at);
  for (const file of files.keys()) {
    const stats = await lstat(file);
    expect(stats.atimeMs, file).toBe(Date.parse(old));
    expect(stats.mtimeMs, file).toBe(Date.parse(old));
  }
});
