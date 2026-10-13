import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ModuleKind, ScriptTarget, preProcessFile, transpileModule } from "typescript";
import { afterEach, expect, it } from "vitest";
import { AT, jsonl, memoryEvent } from "./fixtures.test-helper.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const run = promisify(execFile);

/** Emit only this runtime dependency closure; the child receives JS and production packages. */
const emitMemoryPackage = async (directory: string): Promise<void> => {
  const seen = new Set<string>(), sourceRoot = path.join(root, "src");
  const emit = async (source: string): Promise<void> => {
    if (seen.has(source)) return;
    seen.add(source);
    const relative = path.relative(sourceRoot, source);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Unexpected package source ${source}`);
    const output = path.join(directory, "dist", relative.replace(/\.ts$/u, ".js"));
    const { outputText } = transpileModule(await readFile(source, "utf8"), {
      fileName: source, compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2023 }
    });
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, outputText);
    for (const { fileName } of preProcessFile(outputText, true, true).importedFiles) {
      if (fileName.startsWith(".")) await emit(path.resolve(path.dirname(source), fileName.replace(/\.js$/u, ".ts")));
    }
  };
  await emit(path.join(sourceRoot, "compiler/training/rewind/memory.ts"));
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  await writeFile(path.join(directory, "package.json"), JSON.stringify(manifest));
  const copied = new Set<string>();
  const copyDependency = async (name: string): Promise<void> => {
    if (copied.has(name)) return;
    copied.add(name);
    const source = await realpath(path.join(root, "node_modules", name));
    await cp(source, path.join(directory, "node_modules", name), {
      recursive: true, dereference: true,
      filter: (entry) => !path.relative(source, entry).split(path.sep).includes("node_modules")
    });
    const dependency = JSON.parse(await readFile(path.join(source, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    for (const child of Object.keys(dependency.dependencies ?? {})) await copyDependency(child);
  };
  for (const name of Object.keys(manifest.dependencies)) await copyDependency(name);
};

it("materializes nonempty historical memory in an isolated production package without development dependencies", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rewind-memory-package-")); roots.push(directory);
  await emitMemoryPackage(directory);
  const history = path.join(directory, "history"), event = memoryEvent(1);
  await jsonl(history, "memory/agent%3Aa/self/events.jsonl", [event]);
  await writeFile(path.join(directory, "check.mjs"), `
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFile, readdir } from "node:fs/promises";
// A package below TMPDIR must not borrow dependencies from the enclosing checkout.
const packageRoot = new URL("./", import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context);
  if (!result.url.startsWith("node:") && !result.url.startsWith(packageRoot)) {
    throw Object.assign(new Error("Dependency escaped the production package: " + specifier), { code: "ERR_MODULE_NOT_FOUND" });
  }
  return result;
} });
const { materializeMemory } = await import("spawnfile/dist/compiler/training/rewind/memory.js");
const { openHistory } = await import("spawnfile/dist/compiler/training/rewind/history.js");
const manifest = JSON.parse(await readFile("package.json", "utf8"));
for (const name of Object.keys(manifest.devDependencies)) {
  assert.throws(() => import.meta.resolve(name), { code: "ERR_MODULE_NOT_FOUND" });
}
const result = await materializeMemory({
  input: { section: "memory", id: "self", declaredBy: "agent:a", declarationBase: process.cwd(),
    declaration: { id: "self", store: { kind: "memory" } }, overridden: false },
  at: ${JSON.stringify(AT)}, record: null, history: await openHistory("history"), destination: "out"
});
assert.equal(result.source.seq, 1);
assert.equal(await readFile("out/memory/events.jsonl", "utf8"), ${JSON.stringify(`${JSON.stringify(event)}\n`)});
assert.deepEqual(await readdir("out/memory"), ["events.jsonl"]);
console.log("PRODUCTION_MEMORY_REWIND_OK");
`);
  const result = await run(process.execPath, ["check.mjs"], {
    cwd: directory, env: { ...process.env, NODE_ENV: "production", NODE_PATH: "", NODE_OPTIONS: "" }, timeout: 15_000
  });
  expect(result.stdout.trim()).toBe("PRODUCTION_MEMORY_REWIND_OK");
});
