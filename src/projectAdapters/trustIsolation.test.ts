import { execFileSync } from "node:child_process";
import { chmod, cp, link, lstat, mkdir, readdir, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { type AdapterSandbox, agentManifest, createAdapterSandbox } from "./adapterSandbox.test-helper.js";
import { type DeclaredProjectAdapters, readDeclaredProjectAdapters } from "./declarations.js";
import { isProjectAdapterSetTrusted, resolveAdapterTrustPath, trustProjectAdapterSet } from "./trustStore.js";

let sandbox: AdapterSandbox;
beforeEach(async () => {
  sandbox = await createAdapterSandbox();
  vi.stubEnv("SPAWNFILE_HOME", sandbox.home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(sandbox.root, { force: true, recursive: true });
});

const declare = async (relative: string, runtime: string): Promise<DeclaredProjectAdapters> =>
  (await readDeclaredProjectAdapters(await sandbox.project(relative, agentManifest("a", runtime, { [runtime]: "./m.mjs" }))))!;

const exists = async (target: string): Promise<boolean> => (await lstat(target).catch(() => undefined)) !== undefined;

it("retains concurrent approvals of different projects in separate records", async () => {
  const [first, second] = await Promise.all([declare("one", "first"), declare("two", "second")]);
  const stores = await Promise.all([trustProjectAdapterSet(first), trustProjectAdapterSet(second)]);
  expect(stores).toEqual([resolveAdapterTrustPath(first.manifestPath), resolveAdapterTrustPath(second.manifestPath)]);
  expect(new Set(stores).size).toBe(2);
  await expect(isProjectAdapterSetTrusted(first)).resolves.toBe(true);
  await expect(isProjectAdapterSetTrusted(second)).resolves.toBe(true);
  expect((await readdir(path.dirname(stores[0]!))).filter((name) => name.endsWith(".tmp"))).toEqual([]);

  // A record moved to another project's name does not approve that project.
  await rename(stores[0]!, stores[1]!);
  await expect(isProjectAdapterSetTrusted(second)).resolves.toBe(false);
  await expect(isProjectAdapterSetTrusted(first)).resolves.toBe(false);
});

it("refuses a default store in a project subdirectory whose name starts with two dots", async () => {
  const declared = await declare("p", "one");
  const contained = path.join(declared.projectRoot, "..spawnfile");
  vi.stubEnv("SPAWNFILE_HOME", contained);
  await expect(trustProjectAdapterSet(declared)).rejects.toThrow(/cannot live inside the project/u);
  expect(await exists(contained)).toBe(false);

  vi.stubEnv("SPAWNFILE_HOME", sandbox.home);
  await trustProjectAdapterSet(declared);
  await cp(sandbox.home, contained, { recursive: true });
  vi.stubEnv("SPAWNFILE_HOME", contained);
  await expect(isProjectAdapterSetTrusted(declared)).rejects.toThrow(/cannot live inside the project/u);
});

it("follows a linked SPAWNFILE_HOME to its real directory but refuses redirected trust directories", async () => {
  const declared = await declare("p", "one");
  const alias = path.join(sandbox.root, "home-alias");
  await symlink(sandbox.home, alias);
  vi.stubEnv("SPAWNFILE_HOME", alias);
  await trustProjectAdapterSet(declared);
  await expect(isProjectAdapterSetTrusted(declared)).resolves.toBe(true);

  vi.stubEnv("SPAWNFILE_HOME", sandbox.home);
  const records = path.join(sandbox.home, "trust", "runtime-adapters");
  const elsewhere = path.join(sandbox.root, "elsewhere");
  await rename(records, elsewhere);
  await symlink(elsewhere, records);
  await expect(isProjectAdapterSetTrusted(declared)).rejects.toThrow(/real directory, not a link/u);
  await rm(records);
  await rename(elsewhere, records);

  await chmod(records, 0o770);
  await expect(isProjectAdapterSetTrusted(declared)).rejects.toThrow(/trust directory is writable by group or others/u);
  await chmod(records, 0o700);
  await expect(isProjectAdapterSetTrusted(declared)).resolves.toBe(true);
});

it("refuses hardlinked and non-regular records without blocking", async () => {
  const declared = await declare("p", "one");
  const store = await trustProjectAdapterSet(declared);
  const extra = path.join(sandbox.root, "extra-link.json");
  await link(store, extra);
  await expect(isProjectAdapterSetTrusted(declared)).rejects.toThrow(/regular file with one link/u);
  await rm(extra);
  await expect(isProjectAdapterSetTrusted(declared)).resolves.toBe(true);

  await rm(store);
  await mkdir(store);
  await expect(isProjectAdapterSetTrusted(declared)).rejects.toThrow(/regular file with one link/u);
  await rm(store, { recursive: true });

  if (process.platform !== "win32") {
    execFileSync("mkfifo", [store]);
    await expect(isProjectAdapterSetTrusted(declared)).rejects.toThrow(/regular file with one link/u);
  }
});
