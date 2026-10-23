import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  generateEngineDescriptorArtifacts,
  readPinnedDaimonCommit,
  readStaticEngineDescriptors,
  renderEngineDescriptorArtifacts,
  verifyEngineDescriptorArtifacts
} from "./generate-daimon-engine-descriptors.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const mirrorDirectory = path.join(root, "src/runtime/daimon");
const pin = readPinnedDaimonCommit(readFileSync(path.join(root, "runtimes.yaml"), "utf8"));
const descriptor = 'export const ENGINE_DESCRIPTORS = { sample: { id: "sample", broker: null, homeEnvironment: "SAMPLE_HOME" } } as const;';
const loadStatic = (source: string): ReturnType<typeof readStaticEngineDescriptors> => readStaticEngineDescriptors(() => source);
const withTemporaryDirectory = (run: (directory: string) => void): void => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "spawnfile-descriptors-"));
  try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
};

test("descriptor mirror is bound to the registry pin, digest and generated TypeScript bytes", () => {
  const mirror = JSON.parse(readFileSync(path.join(mirrorDirectory, "engine-descriptors.json"), "utf8")) as { sourceCommit: string; engines: ReturnType<typeof readStaticEngineDescriptors> };
  assert.equal(mirror.sourceCommit, pin);
  const artifacts = renderEngineDescriptorArtifacts(pin, mirror.engines);
  assert.equal(artifacts.digest, `sha256:${createHash("sha256").update(artifacts.json).digest("hex")}\n`);
  verifyEngineDescriptorArtifacts(artifacts, mirrorDirectory);
});

test("registry parser rejects floating or abbreviated revisions", () => {
  for (const value of ["main", "abc1234", "e".repeat(39), "E".repeat(40)]) {
    assert.throws(() => readPinnedDaimonCommit(`runtimes:\n  daimon:\n    ref: ${value}\n`), /full Daimon commit pin/u);
  }
  assert.throws(() => readPinnedDaimonCommit("runtimes: {}"), /full Daimon commit pin/u);
  assert.equal(readPinnedDaimonCommit(`runtimes:\n  daimon:\n    ref: ${"e".repeat(40)}\n`), "e".repeat(40));
});

test("static evaluator follows named imports and preserves descriptor values", () => {
  const sources: Record<string, string> = {
    "src/engines/descriptors.ts": 'import { HOME as DIRECTORY, VALUES } from "./descriptorContracts.js"; export const ENGINE_DESCRIPTORS = { sample: { id: "sample", home: `${DIRECTORY}/auth.json`, values: VALUES, flag: true, none: null, mode: 0o700 } } as const; export type Kind = keyof typeof ENGINE_DESCRIPTORS;',
    "src/engines/descriptorContracts.ts": 'export const HOME = ".sample"; export const VALUES = Object.freeze(["low", "high", false, 48] as const);'
  };
  const engines = readStaticEngineDescriptors((filename) => {
    assert.ok(Object.hasOwn(sources, filename));
    return sources[filename]!;
  });
  assert.deepEqual(JSON.parse(JSON.stringify(engines)), {
    sample: { id: "sample", home: ".sample/auth.json", values: ["low", "high", false, 48], flag: true, none: null, mode: 448 }
  });
});

test("static evaluator rejects executable expressions instead of running upstream code", () => {
  for (const expression of ['process.env.TYPESAFE_API_KEY', '(() => "secret")()', 'Object.keys({})', 'new Date()', '{ get id() { return "sample"; } }']) {
    assert.throws(() => loadStatic(`export const ENGINE_DESCRIPTORS = ${expression};`), /non-static Daimon descriptor syntax/u);
  }
  assert.throws(() => loadStatic(`${descriptor}\nthrow new Error("executed");`), /non-static Daimon descriptor syntax/u);
  assert.throws(() => loadStatic(descriptor.replace("const", "let")), /non-static Daimon descriptor syntax/u);
});

test("static evaluator rejects external imports, source traversal and cycles", () => {
  for (const source of [
    'import { readFileSync } from "node:fs";',
    'import { value } from "../../runtime/handler.js";',
    'import "./handler.js";',
    'import { value } from "./descriptors.js";'
  ]) assert.throws(() => loadStatic(`${source}\n${descriptor}`), /non-static Daimon descriptor syntax|cyclic static descriptor import/u);
});

test("static evaluator refuses missing or mismatched inventory", () => {
  assert.throws(() => loadStatic('export const OTHER = {};'), /non-empty ENGINE_DESCRIPTORS/u);
  assert.throws(() => loadStatic('export const ENGINE_DESCRIPTORS = {};'), /non-empty ENGINE_DESCRIPTORS/u);
  assert.throws(() => loadStatic(descriptor.replace('id: "sample"', 'id: "different"')), /key\/id mismatch/u);
});

test("rendering deterministically sorts keys while retaining array order", () => {
  const first = renderEngineDescriptorArtifacts(pin, { z: { id: "z", values: ["second", "first"] }, a: { id: "a" } });
  const second = renderEngineDescriptorArtifacts(pin, { a: { id: "a" }, z: { values: ["second", "first"], id: "z" } });
  assert.deepEqual(first, second);
  assert.deepEqual((JSON.parse(first.json) as { engines: { z: { values: string[] } } }).engines.z.values, ["second", "first"]);
});

test("verification detects a descriptor, pin, digest or TypeScript mirror mutation", () => {
  withTemporaryDirectory((directory) => {
    const artifacts = renderEngineDescriptorArtifacts(pin, loadStatic(descriptor));
    const files = { "engine-descriptors.json": artifacts.json, "engine-descriptors.sha256": artifacts.digest, "engineDescriptors.generated.ts": artifacts.module };
    const reset = (): void => { for (const [filename, bytes] of Object.entries(files)) writeFileSync(path.join(directory, filename), bytes); };
    reset();
    verifyEngineDescriptorArtifacts(artifacts, directory);
    for (const [filename, bytes] of Object.entries(files)) {
      reset();
      writeFileSync(path.join(directory, filename), `${bytes}mutation`);
      assert.throws(() => verifyEngineDescriptorArtifacts(artifacts, directory), /descriptors drifted/u);
    }
    reset();
    assert.throws(() => verifyEngineDescriptorArtifacts(renderEngineDescriptorArtifacts("a".repeat(40), loadStatic(descriptor)), directory), /descriptors drifted/u);
    assert.throws(() => verifyEngineDescriptorArtifacts(renderEngineDescriptorArtifacts(pin, loadStatic(descriptor.replace("SAMPLE_HOME", "CHANGED_HOME"))), directory), /descriptors drifted/u);
  });
});

test("generator reads the exact Git pin even when the checkout has different descriptor bytes", () => {
  withTemporaryDirectory((directory) => {
    const env = { ...process.env };
    delete env.TYPESAFE_API_KEY;
    const git = (...args: string[]): string => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", env });
    const filename = path.join(directory, "src/engines/descriptors.ts");
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, descriptor);
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "test: static descriptor fixture");
    const commit = git("rev-parse", "HEAD").trim();
    writeFileSync(filename, descriptor.replace("SAMPLE_HOME", "UNCOMMITTED_HOME"));
    const artifacts = generateEngineDescriptorArtifacts(directory, commit);
    assert.match(artifacts.json, /SAMPLE_HOME/u);
    assert.doesNotMatch(artifacts.json, /UNCOMMITTED_HOME/u);
    assert.match(artifacts.module, new RegExp(commit, "u"));
    assert.throws(() => generateEngineDescriptorArtifacts("relative", commit), /must be absolute/u);
    assert.throws(() => generateEngineDescriptorArtifacts(directory, "main"), /full commit pin/u);
  });
});

test("CI verifies generated descriptors using the existing exact pinned Daimon checkout", () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/test.yml"), "utf8");
  assert.match(workflow, /ref: \$\{\{ steps\.daimon-fixture\.outputs\.ref \}\}/u);
  assert.match(workflow, /SPAWNFILE_DAIMON_SOURCE_DIR: \$\{\{ github\.workspace \}\}\/\.tmp\/daimon-source\n\s+run: env -u TYPESAFE_API_KEY npm run vendor:daimon-engine-descriptors -- --check/u);
});
