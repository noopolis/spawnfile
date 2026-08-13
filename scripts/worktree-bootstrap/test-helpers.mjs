import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyRepo } from "./verify.mjs";

export const temporary = (callback) => {
  const root = mkdtempSync(path.join(tmpdir(), "bootstrap-worktree-"));
  try { return callback(root); } finally { rmSync(root, { recursive: true, force: true }); }
};
export const fakeRepo = (name = "fake") => ({ name, path: name === "root" ? "." : "ecosystem/" + name, kind: "node", installTargets: [{ path: ".", tier: "suite" }], inherited: [] });
export const writeLocks = (target, receiptPackages, projectPackages = receiptPackages) => {
  mkdirSync(path.join(target, "node_modules"), { recursive: true });
  writeFileSync(path.join(target, "node_modules", ".package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: receiptPackages }));
  writeFileSync(path.join(target, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: projectPackages }));
};
export const healthy = (target) => {
  const packages = { "node_modules/alpha": { version: "1.0.0" }, "node_modules/@scope/beta": { version: "2.0.0" }, "node_modules/gamma": { version: "3.0.0" } };
  writeLocks(target, packages);
  for (const key of Object.keys(packages)) { mkdirSync(path.join(target, key), { recursive: true }); writeFileSync(path.join(target, key, "package.json"), JSON.stringify({ name: key, version: packages[key].version })); }
};
export const packageSet = (version = "1.0.0") => ({ "node_modules/alpha": { version } });
export const materializePackages = (target, packages) => {
  writeLocks(target, packages);
  for (const key of Object.keys(packages)) { mkdirSync(path.join(target, key), { recursive: true }); writeFileSync(path.join(target, key, "package.json"), JSON.stringify({ name: key, version: packages[key].version })); }
};
export const copyDirectory = (source, destination) => cpSync(source, destination, { recursive: true });
export const verify = (root, repo = fakeRepo(), smoke = false) => verifyRepo({ repo, worktree: root, rootWorktree: root, registry: { [repo.name]: repo }, checkGitWorktree: false, smoke });
export const assertMessage = (failures, absolutePath, pattern) => {
  const message = failures.find((entry) => entry.startsWith("WORKTREE ") && entry.includes(absolutePath) && pattern.test(entry));
  assert.ok(message, "expected prefixed failure containing " + absolutePath + " and " + pattern + "\n" + failures.join("\n"));
};
