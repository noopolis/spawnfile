import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const javascriptSources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory()
    ? javascriptSources(path.join(directory, entry.name))
    : /\.(?:[cm]?js)$/.test(entry.name) ? [path.join(directory, entry.name)] : []);

test("maintained scripts contain no JavaScript source files", () => {
  assert.deepEqual(javascriptSources(fileURLToPath(new URL(".", import.meta.url))), []);
});

test("script language check detects a nested JavaScript regression", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "spawnfile-script-policy-"));
  try {
    const filename = path.join(root, "regression.mjs");
    writeFileSync(filename, "export const value = 1;\n");
    assert.deepEqual(javascriptSources(root), [filename]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
