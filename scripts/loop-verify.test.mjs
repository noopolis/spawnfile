import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { checkDistFreshness, parseTapSummary } from "./loop-verify.mjs";

const makeTree = () => {
  const root = mkdtempSync(path.join(tmpdir(), "loop-verify-"));
  const simfileDir = path.join(root, "simfile");
  mkdirSync(path.join(simfileDir, "src"), { recursive: true });
  return { root, simfileDir };
};

const writeLevel = (directory, name, sourceTime = 1_000, outputTime = 1_000) => {
  const source = path.join(directory, "src", `${name}.ts`);
  const output = path.join(directory, "dist", `${name}.js`);
  mkdirSync(path.dirname(source), { recursive: true });
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(source, "export const value = 1;\n");
  writeFileSync(output, "export const value = 1;\n");
  utimesSync(source, sourceTime / 1_000, sourceTime / 1_000);
  utimesSync(output, outputTime / 1_000, outputTime / 1_000);
  return { source, output };
};

const withTree = (callback) => {
  const tree = makeTree();
  try {
    callback(tree);
  } finally {
    rmSync(tree.root, { force: true, recursive: true });
  }
};

test("freshness rejects a vacuous zero-source scan", () => withTree(({ simfileDir }) => {
  const [simfile] = checkDistFreshness({ simfileDir });
  assert.match(simfile.problems.join("\n"), /simfile root: scanned no sources/u);
}));

test("freshness rejects missing and empty dist output", () => withTree(({ simfileDir }) => {
  writeFileSync(path.join(simfileDir, "src", "source.ts"), "export const value = 1;\n");
  const levels = checkDistFreshness({ simfileDir });
  assert.match(levels[0].problems.join("\n"), /dist directory is absent/u);
}));

test("freshness names a source newer than its expected output", () => withTree(({ simfileDir }) => {
  writeLevel(simfileDir, "new-source", 2_000, 1_000);
  const [simfile] = checkDistFreshness({ simfileDir });
  assert.match(simfile.problems.join("\n"), /stale: source .*new-source\.ts .*expected output .*new-source\.js/u);
}));

test("freshness passes with non-zero source and output counts", () => withTree(({ simfileDir }) => {
  writeLevel(simfileDir, "root");
  const levels = checkDistFreshness({ simfileDir });
  assert.deepEqual(levels.map(({ sources, pairs }) => [sources.length, pairs.length]), [[1, 1]]);
  assert.deepEqual(levels.map(({ problems }) => problems), [[]]);
}));

test("freshness rejects an output whose source no longer exists", () => withTree(({ simfileDir }) => {
  writeLevel(simfileDir, "root");
  const orphan = path.join(simfileDir, "dist", "cli", "deleted-command.js");
  mkdirSync(path.dirname(orphan), { recursive: true });
  writeFileSync(orphan, "stale\n");
  utimesSync(orphan, 1, 1);
  const [simfile] = checkDistFreshness({ simfileDir });
  assert.deepEqual(simfile.orphanOutputs, [orphan]);
  assert.match(simfile.problems.join("\n"), /orphan output .*deleted-command\.js: its source no longer exists/u);
}));

test("TAP summary accepts a non-zero passing plan", () => {
  assert.deepEqual(parseTapSummary("1..8\n# pass 8\n# fail 0\n"), { passed: 8 });
});

test("TAP summary rejects a zero plan", () => {
  assert.throws(() => parseTapSummary("1..0\n# pass 0\n# fail 0\n"), /ran zero tests/u);
});

test("TAP summary rejects empty or garbage output", () => {
  assert.throws(() => parseTapSummary(""), /absent or unparseable/u);
  assert.throws(() => parseTapSummary("not TAP\n"), /absent or unparseable/u);
});

test("freshness fails when a source expected output is missing", () => withTree(({ simfileDir }) => {
  writeLevel(simfileDir, "root");
  const missingSource = path.join(simfileDir, "src", "missing.ts");
  writeFileSync(missingSource, "export const missing = true;\n");
  const [simfile] = checkDistFreshness({ simfileDir });
  assert.match(
    simfile.problems.join("\n"),
    /missing output for source .*missing\.ts: expected .*[/\\]dist[/\\]missing\.js$/mu,
  );
}));

test("freshness catches one stale mapped source among fresh siblings", () => withTree(({ simfileDir }) => {
  writeLevel(simfileDir, "stale", 3_000, 2_000);
  writeLevel(simfileDir, "fresh", 1_000, 4_000);
  const [simfile] = checkDistFreshness({ simfileDir });
  assert.match(simfile.problems.join("\n"), /stale: source .*stale\.ts/u);
}));

test("freshness rejects a vacuous zero-pair mapping", () => withTree(({ simfileDir }) => {
  writeFileSync(path.join(simfileDir, "src", "missing.ts"), "export const missing = true;\n");
  const unrelated = path.join(simfileDir, "dist", "viewer", "unrelated.js");
  mkdirSync(path.dirname(unrelated), { recursive: true });
  writeFileSync(unrelated, "unrelated\n");
  const [simfile] = checkDistFreshness({ simfileDir });
  assert.equal(simfile.sources.length, 1);
  assert.equal(simfile.pairs.length, 0);
  assert.match(simfile.problems.join("\n"), /simfile root: mapped no source\/output pairs/u);
}));
