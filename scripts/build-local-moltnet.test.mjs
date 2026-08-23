import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hashTrackedSourceEntries } from "./build-local-moltnet.mjs";

test("source hashing accepts contained CLAUDE symlinks deterministically", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "spawnfile-source-hash-"));
  writeFileSync(path.join(root, "AGENTS.md"), "# Guide\n");
  symlinkSync("AGENTS.md", path.join(root, "CLAUDE.md"));
  const entries = [{ mode: "100644", path: "AGENTS.md" }, { mode: "120000", path: "CLAUDE.md" }];
  assert.equal(hashTrackedSourceEntries(root, entries), hashTrackedSourceEntries(root, [...entries].reverse()));
});

test("source hashing rejects escaping symlinks", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "spawnfile-source-hash-"));
  symlinkSync("../outside", path.join(root, "CLAUDE.md"));
  assert.throws(() => hashTrackedSourceEntries(root, [{ mode: "120000", path: "CLAUDE.md" }]), /escapes/);
});

test("source hashing rejects contained symlinks to untracked content", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "spawnfile-source-hash-"));
  writeFileSync(path.join(root, "private.md"), "not tracked\n");
  symlinkSync("private.md", path.join(root, "CLAUDE.md"));
  assert.throws(() => hashTrackedSourceEntries(root, [{ mode: "120000", path: "CLAUDE.md" }]), /not a tracked/u);
});
