import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { assertExpectedCases, discoverTestFiles, parseTapSummary } from "./tap-self-test.mjs";

test("shared TAP parser accepts a healthy summary", () => {
  assert.deepEqual(parseTapSummary("1..2\n# pass 2\n# fail 0\n"), { passed: 2 });
});

test("shared TAP parser rejects the empty-file wrapper", () => {
  assert.throws(() => parseTapSummary("# Subtest: empty.test.mjs\nok 1 - empty.test.mjs\n1..1\n# tests 1\n# pass 1\n# fail 0\n"), /registered zero tests: empty\.test\.mjs/u);
});

test("shared TAP parser rejects zero passes and failures", () => {
  assert.throws(() => parseTapSummary("1..2\n# pass 0\n# fail 0\n"), /zero passed/u);
  assert.throws(() => parseTapSummary("1..2\n# pass 1\n# fail 1\n"), /1 failed/u);
});

test("test discovery recurses and sorts test files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "tap-self-test-"));
  try {
    mkdirSync(path.join(root, "nested"));
    writeFileSync(path.join(root, "z.test.mjs"), "");
    writeFileSync(path.join(root, "nested", "a.test.mjs"), "");
    assert.deepEqual(discoverTestFiles(root), ["nested/a.test.mjs", "z.test.mjs"]);
  } finally { rmSync(root, { force: true, recursive: true }); }
});

test("test discovery honors relative and basename exclusions", () => {
  const root = mkdtempSync(path.join(tmpdir(), "tap-self-test-"));
  try {
    mkdirSync(path.join(root, "nested"));
    writeFileSync(path.join(root, "keep.test.mjs"), "");
    writeFileSync(path.join(root, "nested", "skip.test.mjs"), "");
    assert.deepEqual(discoverTestFiles(root, { exclude: ["skip.test.mjs"] }), ["keep.test.mjs"]);
  } finally { rmSync(root, { force: true, recursive: true }); }
});

test("expected cases reject a missing declared minimum", () => {
  assert.throws(() => assertExpectedCases("ok 1 - present\n# pass 1\n", { minimumCases: 2, requiredCaseNames: ["present"] }), /at least 2.*found 1/u);
});

test("expected cases reject a missing required title", () => {
  assert.throws(() => assertExpectedCases("ok 1 - present\n# pass 1\n", { minimumCases: 1, requiredCaseNames: ["missing"] }), /required self-test case missing or not passing: missing/u);
});

test("expected cases accept the declared minimum and titles", () => {
  assert.doesNotThrow(() => assertExpectedCases("ok 1 - first\nok 2 - second\n# pass 2\n", { minimumCases: 2, requiredCaseNames: ["first", "second"] }));
});
