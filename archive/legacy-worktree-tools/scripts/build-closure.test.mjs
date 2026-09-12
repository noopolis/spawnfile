import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildClosure, parseArgs, resolveBuildOrder } from "./build-closure.mjs";

const fake = (names, dependencies = {}) => Object.fromEntries(names.map((name) => [name, {
  name, path: name, build: { command: "fake", args: [name], cwd: "." }, buildDependsOn: dependencies[name] || [],
}]));
const prepared = (registry, root) => { for (const repo of Object.values(registry)) { repo.worktree = path.join(root, repo.name); mkdirSync(path.join(repo.worktree, "node_modules"), { recursive: true }); } };
const runWith = (registry, root, options = {}) => { const executed = []; return { executed, result: buildClosure({ registry, cwd: root, run: (...args) => { executed.push(args[2]); }, inspect: () => ({ problems: [] }), report: () => {}, ...options }) }; };

test("build closure orders every dependency before its dependent", () => { const registry = fake(["root", "middle", "leaf"], { root: ["middle"], middle: ["leaf"] }); const root = mkdtempSync(path.join(tmpdir(), "closure-order-")); try { prepared(registry, root); const { executed } = runWith(registry, root, { requested: ["root"] }); assert.deepEqual(executed, [registry.leaf.worktree, registry.middle.worktree, registry.root.worktree]); } finally { rmSync(root, { recursive: true, force: true }); } });
test("build closure resolves transitively from a single root", () => { const registry = fake(["root", "stele", "mneme"], { root: ["stele", "mneme"] }); assert.deepEqual(resolveBuildOrder({ registry, requested: ["root"] }), ["stele", "mneme", "root"]); });
test("build closure rejects a dependency cycle by name", () => { const registry = fake(["a", "b"], { a: ["b"], b: ["a"] }); assert.throws(() => resolveBuildOrder({ registry, requested: ["a"] }), /dependency cycle: a -> b -> a/u); });
test("build closure rejects an unknown repo name", () => { assert.throws(() => resolveBuildOrder({ registry: fake(["root"]), requested: ["badname"] }), /Unknown repo badname/u); });
test("build closure refuses an unbootstrapped repo with the bootstrap command", () => { const registry = fake(["root"]); const root = mkdtempSync(path.join(tmpdir(), "closure-env-")); try { assert.throws(() => buildClosure({ registry, requested: ["root"], cwd: root, report: () => {} }), /ENVIRONMENT.*root.*node_modules.*bootstrap-worktree\.mjs --item <ITEM> --repos root/u); } finally { rmSync(root, { recursive: true, force: true }); } });
test("build closure reports a null-build repo as an explicit skip", () => { const reports = []; const registry = { moltnet: { name: "moltnet", build: null, buildDependsOn: [], buildSkipReason: "Docker remote SSH context" } }; assert.throws(() => buildClosure({ registry, requested: ["moltnet"], report: (line) => reports.push(line) }), /built zero repos/u); assert.ok(reports.some((line) => line === "BUILD SKIPPED: moltnet — Docker remote SSH context")); });
test("build closure fails when it would build zero repos", () => { const registry = { skipped: { name: "skipped", build: null, buildDependsOn: [], buildSkipReason: "not applicable" } }; assert.throws(() => buildClosure({ registry, requested: ["skipped"], report: () => {} }), /built zero repos/u); });
test("build closure never copies a build output", () => { const source = readFileSync(new URL("./build-closure.mjs", import.meta.url), "utf8"); assert.doesNotMatch(source, /\b(?:cp|cpSync|clonefile|rsync|link|rename)\b/u); });
test("build closure fails a repo that builds stale output", () => { const registry = fake(["root"]); const root = mkdtempSync(path.join(tmpdir(), "closure-stale-")); try { prepared(registry, root); assert.throws(() => buildClosure({ registry, requested: ["root"], cwd: root, run: () => {}, inspect: () => ({ problems: ["stale output"] }), report: () => {} }), /BUILD STALE: root: stale output/u); } finally { rmSync(root, { recursive: true, force: true }); } });
test("--for accepts the space form and the comma form identically", () => { assert.deepEqual(parseArgs(["--for", "root", "simfile"]).forText, parseArgs(["--for", "root,simfile"]).forText); });
