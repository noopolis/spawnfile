import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { requireDrainOperations } from "../release/drainControl.js";
import { RuntimeAdapterBase } from "./adapterBase.js";
import { createRuntimeInstallRecipe } from "./container.js";
import { loadRuntimeAdapterPlugins } from "./loadAdapterPlugins.js";
import { defineRuntimeAdapterPlugin } from "./pluginDefinition.js";
import { addRuntimeAdapterPlugins, assertRuntimeCanCompile, getRuntimeAdapter, getRuntimeOperations, listRuntimeAdapters, listRuntimeOperations, withRuntimeAdapterPlugins } from "./registry.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

class Adapter extends RuntimeAdapterBase {
  #settings = '{"configured":true}';
  readonly container = {
    configFileName: "config.json",
    instancePaths: { configPathTemplate: "<instance-root>/config.json", workspacePathTemplate: "<instance-root>/workspace" },
    standaloneBaseImage: "node:24-bookworm-slim",
    startCommand: ["fixture-runtime"],
    systemDeps: []
  };

  constructor(readonly name: string) { super(); }

  async compileAgent() {
    return {
      capabilities: [], diagnostics: [],
      files: [{ path: this.container.configFileName, content: this.#settings }]
    };
  }
}

const plugin = (name: string) => defineRuntimeAdapterPlugin({
  apiVersion: 1,
  adapter: new Adapter(name),
  catalog: {
    defaultBranch: "main", ref: "v1", remote: "https://example.invalid/plugin.git",
    install: { kind: "npm", package: "fixture-runtime", version: "1.0.0" }
  }
});

it("admits each batch atomically when concurrent registrations share a scope", async () => {
  await withRuntimeAdapterPlugins([], async () => {
    const results = await Promise.allSettled([
      addRuntimeAdapterPlugins([plugin("overlap")]),
      addRuntimeAdapterPlugins([plugin("overlap")])
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
    await expect(addRuntimeAdapterPlugins([plugin("partial"), plugin("overlap")])).rejects.toThrow(/Duplicate/u);
    expect(listRuntimeAdapters()).not.toContain("partial");
  });
});

it("projects scoped catalog metadata, preserves the adapter receiver, and resolves standard recipes", async () => {
  const scoped = plugin("fixture-one");
  await withRuntimeAdapterPlugins([scoped], async () => {
    await expect(assertRuntimeCanCompile("fixture-one")).resolves.toMatchObject({ ref: "v1", status: "active" });
    expect(getRuntimeAdapter("fixture-one")).toBe(scoped.adapter);
    const recipe = await createRuntimeInstallRecipe("fixture-one");
    expect(recipe.commands).toEqual(["npm install -g --omit=dev --no-fund --no-audit fixture-runtime@1.0.0"]);
    expect(recipe.runtimeRoot).toBe("/usr/local/lib/node_modules/fixture-runtime");
    const adapter = getRuntimeAdapter("fixture-one") as Adapter;
    await expect(adapter.compileAgent()).resolves.toMatchObject({ files: [{ content: '{"configured":true}', path: "config.json" }] });
  });
  expect(listRuntimeAdapters()).not.toContain("fixture-one");
  await expect(assertRuntimeCanCompile("fixture-one")).rejects.toThrow(/Unknown runtime binding/u);
});

it("isolates overlapping and nested library invocations", async () => {
  let release!: () => void;
  const otherReady = new Promise<void>((resolve) => { release = resolve; });
  const first = withRuntimeAdapterPlugins([plugin("first")], async () => {
    await otherReady;
    expect(listRuntimeAdapters()).toContain("first");
    expect(listRuntimeAdapters()).not.toContain("second");
    await withRuntimeAdapterPlugins([], () => expect(listRuntimeAdapters()).not.toContain("first"));
    expect(listRuntimeAdapters()).toContain("first");
  });
  const second = withRuntimeAdapterPlugins([plugin("second")], () => {
    release();
    expect(listRuntimeAdapters()).toContain("second");
    expect(listRuntimeAdapters()).not.toContain("first");
  });
  await Promise.all([first, second]);
  expect(listRuntimeAdapters()).not.toContain("second");
});

it("releases a completed invocation's registrations for delayed work", async () => {
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  let later!: Promise<string[]>;
  await withRuntimeAdapterPlugins([plugin("scoped-adapter")], () => {
    later = gate.then(listRuntimeAdapters);
    expect(listRuntimeAdapters()).toContain("scoped-adapter");
  });
  resume();
  expect(await later).not.toContain("scoped-adapter");
});

it("rejects malformed raw credential import declarations", async () => {
  const definition = plugin("invalid-auth");
  Object.assign(definition.adapter.container, { rawHomeAuthImports: "codex" });
  await expect(withRuntimeAdapterPlugins([definition], () => undefined)).rejects.toThrow(/invalid adapter implementation/u);
});

it("selects a registered external lifecycle capability only inside its invocation", async () => {
  const definition = plugin("external-lifecycle");
  const operations = {
    drain: {
      async drain() { return { drain: "draining" as const, state: "ready" }; },
      async resume() { return { drain: null, state: "ready" }; },
      async availability() { return { drain: "drained" as const, state: "ready" }; }
    }
  };
  definition.adapter.operations = operations;
  const target = {
    runtime: definition.adapter.name, containerRef: "unit", imageRef: "fixture", dockerArgs: [],
    dockerCommand: "docker", token: "synthetic"
  };
  await withRuntimeAdapterPlugins([definition], async () => {
    expect(listRuntimeOperations()).toContain(operations);
    expect(getRuntimeOperations(target.runtime)).toBe(operations);
    await expect(requireDrainOperations(target).drain(target)).resolves.toEqual({ drain: "draining", state: "ready" });
  });
  expect(getRuntimeOperations(target.runtime)).toBeUndefined();
  expect(() => requireDrainOperations(target)).toThrow(/no registered drain contract/u);
});

it("allows implementing an exploratory catalog name and rejects shadowing or duplicates", async () => {
  await expect(assertRuntimeCanCompile("openfang")).rejects.toThrow(/exploratory/u);
  await withRuntimeAdapterPlugins([plugin("openfang")], async () => {
    await expect(assertRuntimeCanCompile("openfang")).resolves.toMatchObject({ ref: "v1", status: "active" });
  });
  await expect(assertRuntimeCanCompile("openfang")).rejects.toThrow(/exploratory/u);
  await expect(withRuntimeAdapterPlugins([plugin("daimon")], () => undefined)).rejects.toThrow(/cannot shadow/u);
  await expect(withRuntimeAdapterPlugins([plugin("duplicate"), plugin("duplicate")], () => undefined)).rejects.toThrow(/Duplicate/u);
});

it.each([
  ["prepareRuntimeAuth", "not a function", "adapter.prepareRuntimeAuth"],
  ["training", "string", "adapter.training"],
  ["host", "string", "adapter.host"],
  ["host", { entrypoint: { rootfsFiles: false } }, "adapter.host.entrypoint.rootfsFiles"]
] as const)("rejects a malformed %s capability", async (key, value, error) => {
  const definition = plugin("bad-hook");
  Object.assign(definition.adapter, { [key]: value });
  await expect(withRuntimeAdapterPlugins([definition], () => undefined)).rejects.toThrow(error);
});

const source = (name: string, apiVersion = 1): string => `
export const spawnfileAdapter = {
  apiVersion: ${apiVersion},
  adapter: {
    name: ${JSON.stringify(name)},
    assertSupportedModelTarget() {},
    async compileAgent() { return { files: [], capabilities: [], diagnostics: [] }; },
    container: {
      configFileName: "config.json", standaloneBaseImage: "node:24-bookworm-slim",
      startCommand: ["test"], systemDeps: [],
      instancePaths: { configPathTemplate: "/config.json", workspacePathTemplate: "/workspace" }
    },
    install: {
      hints: Object.fromEntries(["container_image", "github_release_archive", "npm", "source_repo"]
        .map(kind => [kind, { ecosystem: "node", installHint: "fixture" }])),
      createRecipe(input) { return { commands: [], copyCommands: [], env: input.containerEnv, runtimeName: input.runtimeName, runtimeRoot: input.installRoot }; }
    }
  },
  catalog: { ref: "v1", remote: "https://example.invalid/plugin", defaultBranch: "main" }
};
`;

it("loads only explicitly selected local and import-only installed ESM modules from the operator directory", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "spawnfile-plugin-test-"));
  roots.push(cwd);
  const packageDirectory = path.join(cwd, "node_modules", "example-adapter");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(path.join(packageDirectory, "package.json"), JSON.stringify({
    name: "example-adapter", type: "module", exports: { import: "./entry.js" }
  }));
  await writeFile(path.join(packageDirectory, "entry.js"), source("installed-adapter"));
  await writeFile(path.join(cwd, "local.mjs"), source("local-adapter"));
  await writeFile(path.join(cwd, "wrong.mjs"), source("wrong", 2));
  await writeFile(path.join(cwd, "bad.mjs"), "export const spawnfileAdapter = { apiVersion: 1, adapter: { name: 'empty' } };");

  const plugins = await loadRuntimeAdapterPlugins(["./local.mjs", "example-adapter"], { cwd });
  expect(plugins.map(({ adapter }) => adapter.name)).toEqual(["local-adapter", "installed-adapter"]);
  expect(listRuntimeAdapters()).not.toContain("installed-adapter");
  await expect(loadRuntimeAdapterPlugins(["./wrong.mjs"], { cwd })).rejects.toThrow(/unsupported apiVersion 2/u);
  await expect(loadRuntimeAdapterPlugins(["./bad.mjs"], { cwd })).rejects.toThrow(/invalid adapter implementation/u);
  await expect(loadRuntimeAdapterPlugins(["not-an-installed-package"], { cwd })).rejects.toThrow(/Unable to load adapter.*not-an-installed-package/u);
});

it.each([
  { kind: "npm", package: "fixture runtime", version: "1.0.0" },
  { kind: "npm", package: "fixture-runtime", version: "^1.0.0" },
  { kind: "container_image", image: "example/fixture:already-tagged", tag: "v1" }
] as const)("validates standard registry pins used by external installers", async (install) => {
  const definition = plugin("fixture-pins");
  await expect(withRuntimeAdapterPlugins([{ ...definition, catalog: { ...definition.catalog, install } }], () => undefined))
    .rejects.toThrow(/invalid catalog/u);
});
