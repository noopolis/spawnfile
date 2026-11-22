import { mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { isAdapterSpecifier } from "../manifest/index.js";
import { listRuntimeAdapters, withRuntimeAdapterPlugins } from "../runtime/registry.js";
import { type AdapterSandbox, adapterModuleSource, agentManifest, createAdapterSandbox } from "./adapterSandbox.test-helper.js";
import { readDeclaredProjectAdapters } from "./declarations.js";
import { loadProjectRuntimeAdapterPlugins } from "./loadProjectAdapters.js";

let sandbox: AdapterSandbox;
beforeEach(async () => {
  sandbox = await createAdapterSandbox();
  vi.stubEnv("SPAWNFILE_HOME", sandbox.home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(sandbox.root, { force: true, recursive: true });
});

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

it("loads the current declarations on every call without creating a Spawnfile home", async () => {
  const project = await sandbox.project("p", agentManifest("a", "one", { one: "./one.mjs" }), {
    "one.mjs": "one", "replacement.mjs": "one", "two.mjs": "two"
  });
  const plugins = await loadProjectRuntimeAdapterPlugins(project);
  expect(plugins.map(({ adapter }) => adapter.name)).toEqual(["one"]);
  expect(listRuntimeAdapters()).not.toContain("one");
  expect(await sandbox.evaluated()).toEqual(["one"]);

  await writeFile(path.join(project, "Spawnfile"), agentManifest("a", "one", { one: "./replacement.mjs", two: "./two.mjs" }));
  const updated = await loadProjectRuntimeAdapterPlugins(project);
  expect(updated.map(({ adapter }) => adapter.name)).toEqual(["one", "two"]);
  expect(await sandbox.evaluated()).toEqual(["one", "one", "two"]);
  await expect(stat(sandbox.home)).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses bundled names, escaping symlinks and missing files before import; refuses name mismatch before registration", async () => {
  await writeFile(path.join(sandbox.root, "outside.mjs"), adapterModuleSource("outside", sandbox.marker));
  const builtin = await sandbox.project("builtin", agentManifest("a", "openclaw", { openclaw: "./o.mjs" }), { "o.mjs": "openclaw" });
  await expect(loadProjectRuntimeAdapterPlugins(builtin)).rejects.toThrow(/bundled runtimes cannot be replaced/u);

  const escape = await sandbox.project("escape", agentManifest("a", "outside", { outside: "./link.mjs" }));
  await symlink(path.join(sandbox.root, "outside.mjs"), path.join(escape, "link.mjs"));
  await expect(loadProjectRuntimeAdapterPlugins(escape)).rejects.toThrow(/outside the project directory/u);

  const missing = await sandbox.project("missing", agentManifest("a", "gone", { gone: "./gone.mjs" }));
  await expect(loadProjectRuntimeAdapterPlugins(missing)).rejects.toThrow(/does not exist/u);

  const mismatch = await sandbox.project("mismatch", agentManifest("a", "declared", { declared: "./m.mjs" }), { "m.mjs": "actual" });
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
  const plugins = await loadProjectRuntimeAdapterPlugins(path.join(project, "Spawnfile"), { provided: new Set(["local"]) });
  expect(plugins.map(({ adapter }) => adapter.name)).toEqual(["pkg-runtime"]);
  expect(await sandbox.evaluated()).toEqual(["pkg-runtime"]);
  await expect(loadProjectRuntimeAdapterPlugins(project, { provided: new Set(["local", "pkg-runtime"]) })).resolves.toEqual([]);
});
