#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NODE_IMAGE = "node:24-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df";
const fail = (message) => { throw new Error(message); };
const absolute = (value, label) => {
  if (!value || !path.isAbsolute(value) || path.resolve(value) !== value) fail(`${label} must be a normalized absolute path`);
  return value;
};

export const validateClosureProject = (root) => {
  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  if (lock.lockfileVersion !== 3 || !lock.packages?.[""]) fail("dependency closure requires package-lock v3");
  const codex = lock.packages["node_modules/@openai/codex"];
  if (!codex || typeof codex.version !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(codex.integrity ?? "")) fail("dependency closure requires integrity-pinned @openai/codex");
  if (!lock.packages["node_modules/typescript"]) fail("dependency closure requires locked TypeScript");
  const declared = { ...packageJson.dependencies, ...packageJson.devDependencies }["@openai/codex"];
  if (!declared || /^(?:\^|~|>|<|\*|latest)/u.test(declared)) fail("@openai/codex must be exactly pinned");
  return { codex_version: codex.version };
};

const normalizeCacheIndex = (root) => {
  const visit = (directory) => { for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name); if (entry.isDirectory()) visit(target); else if (entry.isFile()) {
      const lines = readFileSync(target, "utf8").trim().split("\n").filter(Boolean).map((line) => {
        const tab = line.indexOf("\t"), value = JSON.parse(line.slice(tab + 1)); value.time = 0;
        const json = JSON.stringify(value); return `${createHash("sha1").update(json).digest("hex")}\t${json}`;
      }); writeFileSync(target, `${lines.join("\n")}\n`);
    }
  } };
  visit(root);
};

const hydrateLockIntegrities = (root) => {
  const byUrl = new Map(); const visit = (directory) => { for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name); if (entry.isDirectory()) visit(target); else if (entry.isFile()) for (const line of readFileSync(target, "utf8").trim().split("\n").filter(Boolean)) {
      const value = JSON.parse(line.slice(line.indexOf("\t") + 1)); if (typeof value.key === "string" && typeof value.integrity === "string") byUrl.set(value.key.replace(/^make-fetch-happen:request-cache:/u, ""), value.integrity);
    }
  } }; visit(path.join(root, "npm-cache", "_cacache", "index-v5"));
  const lockPath = path.join(root, "package-lock.json"), lock = JSON.parse(readFileSync(lockPath, "utf8"));
  for (const [key, entry] of Object.entries(lock.packages ?? {})) if (key.startsWith("node_modules/") && !entry.integrity) {
    const integrity = byUrl.get(entry.resolved); if (!integrity) fail(`npm cache lacks immutable content identity for ${key.slice(13)}`); entry.integrity = integrity;
  }
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
};

export const createLinuxAmd64Closure = (input, output, codexVersion) => {
  const source = absolute(input, "input"); absolute(output, "output");
  if (!lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink()) fail("input must be a real directory");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(codexVersion ?? "")) fail("Codex version must be an exact semver");
  if (existsSync(output) && readdirSync(output).length) fail("output must be absent or empty");
  const sourceLock = JSON.parse(readFileSync(path.join(source, "package-lock.json"), "utf8"));
  if (sourceLock.lockfileVersion !== 3 || !sourceLock.packages?.["node_modules/typescript"]) fail("source requires a package-lock v3 graph with TypeScript");
  mkdirSync(output, { recursive: true }); const staging = mkdtempSync(path.join(os.tmpdir(), "spawnfile-closure-project-"));
  copyFileSync(path.join(source, "package.json"), path.join(staging, "package.json")); copyFileSync(path.join(source, "package-lock.json"), path.join(staging, "package-lock.json"));
  for (const name of readdirSync(source).filter((entry) => entry.endsWith(".tgz")).sort()) copyFileSync(path.join(source, name), path.join(staging, name));
  const run = (network, inputDirectory, command, copyBack) => {
    const id = execFileSync("docker", ["create", "--platform", "linux/amd64", ...(network ? ["--network", network] : []), NODE_IMAGE, "sh", "-ceu", command], { encoding: "utf8" }).trim();
    try { execFileSync("docker", ["cp", `${inputDirectory}/.`, `${id}:/closure`]); execFileSync("docker", ["start", "--attach", id], { stdio: "inherit" }); if (copyBack) execFileSync("docker", ["cp", `${id}:/closure/.`, output]); }
    finally { execFileSync("docker", ["rm", "--force", id], { stdio: "ignore" }); }
  };
  try { run(undefined, staging, `cd /closure; npm install --package-lock-only --ignore-scripts --save-exact @openai/codex@${codexVersion}; npm ci --ignore-scripts --cache /closure/npm-cache; npm ls --all; test \"$(node -p \"process.platform+'/'+process.arch\")\" = linux/x64; rm -rf node_modules`, true); }
  finally { rmSync(staging, { force: true, recursive: true }); }
  hydrateLockIntegrities(output);
  const identity = validateClosureProject(output); if (identity.codex_version !== codexVersion) fail("prepared Codex version disagrees with the requested pin");
  rmSync(path.join(output, "npm-cache", "_logs"), { force: true, recursive: true }); rmSync(path.join(output, "npm-cache", "_update-notifier-last-checked"), { force: true });
  normalizeCacheIndex(path.join(output, "npm-cache", "_cacache", "index-v5"));
  run("none", output, "cd /closure; npm ci --offline --ignore-scripts --cache /closure/npm-cache; npm ls --all; rm -rf node_modules", true);
  rmSync(path.join(output, "npm-cache", "_logs"), { force: true, recursive: true }); rmSync(path.join(output, "npm-cache", "_update-notifier-last-checked"), { force: true });
  normalizeCacheIndex(path.join(output, "npm-cache", "_cacache", "index-v5"));
  return { ...identity, image: NODE_IMAGE, target: "linux/amd64" };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5) fail("usage: create-linux-amd64-dependency-closure <absolute-daimon-source> <absolute-output> <exact-codex-version>");
  process.stdout.write(`${JSON.stringify(createLinuxAmd64Closure(process.argv[2], process.argv[3], process.argv[4]))}\n`);
}
