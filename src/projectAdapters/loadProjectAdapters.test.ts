import { chmod, cp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { isAdapterSpecifier } from "../manifest/index.js";
import { listRuntimeAdapters, withRuntimeAdapterPlugins } from "../runtime/registry.js";
import { type AdapterSandbox, adapterModuleSource, agentManifest, createAdapterSandbox } from "./adapterSandbox.test-helper.js";
import { readDeclaredProjectAdapters } from "./declarations.js";
import { loadProjectRuntimeAdapterPlugins } from "./loadProjectAdapters.js";
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

const trust = async (directory: string) => trustProjectAdapterSet((await readDeclaredProjectAdapters(directory))!);

it("accepts confined relative modules and installed package names, nothing else", () => {
  for (const ok of ["./adapter.mjs", "./lib/a.mjs", "pkg", "@scope/pkg", "@scope/pkg/sub", "pkg/dist/entry.js"]) {
    expect(isAdapterSpecifier(ok), ok).toBe(true);
  }
  for (const bad of [
    "/abs/a.mjs", "../a.mjs", "./../a.mjs", "./a/../../b.mjs", "./", "./.", ".\\a.mjs", "file:///a.mjs",
    "https://x.test/a.mjs", "pkg/../x", "pkg/./x", "@scope/../x", "C:/a.mjs", "a.mjs\0", "node:fs", ""
  ]) expect(isAdapterSpecifier(bad), bad).toBe(false);
});

it("reads declarations as data, sorted, from the canonical manifest without importing", async () => {
  const project = await sandbox.project("p", agentManifest("a", "zeta", { zeta: "./z.mjs", alpha: "./a.mjs" }), {
    "a.mjs": "alpha", "z.mjs": "zeta"
  });
  await symlink(project, path.join(sandbox.root, "alias"));
  const declared = await readDeclaredProjectAdapters(path.join(sandbox.root, "alias"));
  expect(declared).toEqual({
    adapters: [["alpha", "./a.mjs"], ["zeta", "./z.mjs"]],
    manifestPath: path.join(project, "Spawnfile"),
    projectRoot: project
  });
  await expect(readDeclaredProjectAdapters(path.join(sandbox.root, "missing"))).resolves.toBeUndefined();
  const empty = await sandbox.project("empty", "spawnfile_version: \"0.1\"\nkind: agent\nname: a\nruntime: openclaw\nadapters: {}\n");
  await expect(readDeclaredProjectAdapters(empty)).resolves.toBeUndefined();
  await sandbox.project("bad", agentManifest("b", "x", { x: "../escape.mjs" }));
  await expect(readDeclaredProjectAdapters(path.join(sandbox.root, "bad"))).rejects.toThrow(/adapters\.x: adapter modules must be/u);
  expect(await sandbox.evaluated()).toEqual([]);
});

it("refuses missing, changed and cross-project approvals before any module is evaluated", async () => {
  const project = await sandbox.project("p", agentManifest("a", "one", { one: "./one.mjs" }), { "one.mjs": "one", "two.mjs": "two" });
  await expect(loadProjectRuntimeAdapterPlugins(project)).rejects.toThrow(/not approved.*spawnfile adapters trust/su);
  expect(await sandbox.evaluated()).toEqual([]);

  await trust(project);
  const plugins = await loadProjectRuntimeAdapterPlugins(project);
  expect(plugins.map(({ adapter }) => adapter.name)).toEqual(["one"]);
  expect(listRuntimeAdapters()).not.toContain("one");

  await writeFile(path.join(project, "Spawnfile"), agentManifest("a", "one", { one: "./one.mjs", two: "./two.mjs" }));
  await expect(loadProjectRuntimeAdapterPlugins(project)).rejects.toThrow(/changed since approval/u);
  await writeFile(path.join(project, "Spawnfile"), agentManifest("a", "one", { one: "./two.mjs" }));
  await expect(loadProjectRuntimeAdapterPlugins(project)).rejects.toThrow(/not approved/u);

  const copy = path.join(sandbox.root, "copy");
  await cp(project, copy, { recursive: true });
  await writeFile(path.join(project, "Spawnfile"), agentManifest("a", "one", { one: "./one.mjs" }));
  await writeFile(path.join(copy, "Spawnfile"), agentManifest("a", "one", { one: "./one.mjs" }));
  await expect(loadProjectRuntimeAdapterPlugins(copy)).rejects.toThrow(/not approved/u);
  expect(await sandbox.evaluated()).toEqual(["one"]);
});

it("refuses bundled names, escaping symlinks and missing files before import; refuses name mismatch before registration", async () => {
  await writeFile(path.join(sandbox.root, "outside.mjs"), adapterModuleSource("outside", sandbox.marker));
  const builtin = await sandbox.project("builtin", agentManifest("a", "openclaw", { openclaw: "./o.mjs" }), { "o.mjs": "openclaw" });
  await trust(builtin);
  await expect(loadProjectRuntimeAdapterPlugins(builtin)).rejects.toThrow(/bundled runtimes cannot be replaced/u);

  const escape = await sandbox.project("escape", agentManifest("a", "outside", { outside: "./link.mjs" }));
  await symlink(path.join(sandbox.root, "outside.mjs"), path.join(escape, "link.mjs"));
  await trust(escape);
  await expect(loadProjectRuntimeAdapterPlugins(escape)).rejects.toThrow(/outside the project directory/u);

  const missing = await sandbox.project("missing", agentManifest("a", "gone", { gone: "./gone.mjs" }));
  await trust(missing);
  await expect(loadProjectRuntimeAdapterPlugins(missing)).rejects.toThrow(/does not exist/u);

  const mismatch = await sandbox.project("mismatch", agentManifest("a", "declared", { declared: "./m.mjs" }), { "m.mjs": "actual" });
  await trust(mismatch);
  await expect(withRuntimeAdapterPlugins([], async () => {
    await loadProjectRuntimeAdapterPlugins(mismatch);
  })).rejects.toThrow(/declared for runtime "declared".*exports adapter "actual"/u);
  expect(await sandbox.evaluated()).toEqual(["actual"]);
});

it("resolves installed packages from the project, not the caller's directory, and skips explicitly provided ids", async () => {
  const project = await sandbox.project("p", agentManifest("a", "pkg-runtime", { "pkg-runtime": "example-adapter", local: "./l.mjs" }), { "l.mjs": "local" });
  const packageDirectory = path.join(project, "node_modules", "example-adapter");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(path.join(packageDirectory, "package.json"), JSON.stringify({ exports: { import: "./entry.js" }, name: "example-adapter", type: "module" }));
  await writeFile(path.join(packageDirectory, "entry.js"), adapterModuleSource("pkg-runtime", sandbox.marker));
  await trust(project);
  const plugins = await loadProjectRuntimeAdapterPlugins(path.join(project, "Spawnfile"), { provided: new Set(["local"]) });
  expect(plugins.map(({ adapter }) => adapter.name)).toEqual(["pkg-runtime"]);
  expect(await sandbox.evaluated()).toEqual(["pkg-runtime"]);
  await expect(loadProjectRuntimeAdapterPlugins(project, { provided: new Set(["local", "pkg-runtime"]) })).resolves.toEqual([]);
});

it("refuses symlinked, shared-writable or project-owned trust records", async () => {
  const project = await sandbox.project("p", agentManifest("a", "one", { one: "./one.mjs" }), { "one.mjs": "one" });
  const declared = (await readDeclaredProjectAdapters(project))!;
  const store = await trustProjectAdapterSet(declared);
  expect(store).toBe(resolveAdapterTrustPath(declared.manifestPath));
  await expect(isProjectAdapterSetTrusted(declared)).resolves.toBe(true);

  await chmod(store, 0o666);
  await expect(isProjectAdapterSetTrusted(declared)).rejects.toThrow(/writable by group or others/u);
  await chmod(store, 0o600);

  const planted = path.join(project, "planted.json");
  await cp(store, planted);
  await rm(store);
  await symlink(planted, store);
  await expect(isProjectAdapterSetTrusted(declared)).rejects.toThrow(/cannot be symbolic links/u);
  await expect(loadProjectRuntimeAdapterPlugins(project)).rejects.toThrow(/cannot be symbolic links/u);

  vi.stubEnv("SPAWNFILE_HOME", path.join(project, ".spawnfile"));
  await expect(trustProjectAdapterSet(declared)).rejects.toThrow(/cannot live inside the project/u);
  vi.stubEnv("SPAWNFILE_HOME", sandbox.home);
  await rm(path.join(sandbox.home, "trust"), { force: true, recursive: true });
  await symlink(project, path.join(sandbox.home, "trust"));
  await expect(isProjectAdapterSetTrusted(declared)).rejects.toThrow(/real directory, not a link/u);
  expect(await sandbox.evaluated()).toEqual([]);
});
