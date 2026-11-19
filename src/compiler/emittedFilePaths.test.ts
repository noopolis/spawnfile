import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import * as registry from "../runtime/registry.js";
import { writeEmittedFiles } from "./compileProjectSupport.js";
import { createRootfsFiles } from "./containerArtifactsRender.js";
import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import { initProject } from "./initProject.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
const output = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-emitted-paths-"));
  roots.push(root);
  return root;
};

it("writes correctly scoped output and checks a whole batch before new files are written", async () => {
  const root = await output();
  const valid = { path: "workspace/notes.md", content: "fixture\n" };
  await expect(writeEmittedFiles(root, [valid, { path: "workspace/", content: "" }], "runtimes/example"))
    .rejects.toThrow(/canonical relative file path/u);
  expect(await readdir(root)).toEqual([]);

  await writeEmittedFiles(root, [valid], "runtimes/example");
  expect(await readFile(path.join(root, "runtimes/example/workspace/notes.md"), "utf8")).toBe("fixture\n");
});

it("checks init scaffold files before writing the manifest, ignore file or other scaffold files", async () => {
  const root = await output();
  const selected = registry.getRuntimeAdapter("openclaw");
  const original = selected.scaffoldAgentProject!.call(selected);
  vi.spyOn(registry, "getRuntimeAdapter").mockReturnValue({
    ...selected,
    scaffoldAgentProject: () => ({
      ...original,
      files: [{ path: "notes.md", content: "fixture\n" }, { path: "assets/", content: "" }]
    })
  });

  await expect(initProject({ directory: root, runtime: "openclaw" })).rejects.toThrow(/canonical relative file path/u);
  expect(await readdir(root)).toEqual([]);
});

it("checks target file paths before lowering runtime path prefixes", () => {
  const selected = registry.getRuntimeAdapter("openclaw");
  const plan: RuntimeTargetPlan = {
    envFiles: [],
    id: "agent-writer",
    instancePaths: { configPath: "/state/config.json", workspacePath: "/workspace" },
    meta: selected.container,
    modelAuthMethods: {},
    modelSecretsRequired: [],
    runtimeName: selected.name,
    runtimeRoot: "/opt/runtime",
    targetFiles: [{ content: "notes", path: "workspace//notes.md" }]
  };
  expect(() => createRootfsFiles([plan])).toThrow(/canonical relative file path/u);
});
