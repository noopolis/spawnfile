#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectRepoNames } from "./bootstrap-worktree.mjs";
import { inspectDistLevel } from "./loop-verify.mjs";
import { REPOS, REPO_NAMES } from "./worktree-bootstrap/repos.mjs";
import { readReceipt } from "./worktree-bootstrap/receipt.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRun = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit" });
const defaultInspect = ({ repo, worktree }) => inspectDistLevel({
  label: `${repo.name} dist`,
  sourceDir: path.join(worktree, "src"),
  distDir: path.join(worktree, "dist"),
});

export const parseArgs = (args) => {
  const index = args.indexOf("--for");
  const values = [];
  if (index >= 0) for (const value of args.slice(index + 1)) {
    if (value.startsWith("--")) break;
    values.push(value);
  }
  return { list: args.includes("--list"), forText: index < 0 ? null : values.join(",") };
};

export const resolveBuildOrder = ({ registry, requested }) => {
  const names = Object.keys(registry);
  const selected = requested === "all" ? names : requested;
  const unknown = selected.filter((name) => !registry[name]);
  if (unknown.length) throw new Error(`BUILD INVALID: Unknown repo ${unknown.join(", ")}; valid repos: ${names.join(", ")}, all`);
  const needed = new Set();
  const visiting = [];
  const visit = (name) => {
    if (visiting.includes(name)) {
      const cycle = [...visiting.slice(visiting.indexOf(name)), name].join(" -> ");
      throw new Error(`BUILD INVALID: dependency cycle: ${cycle}`);
    }
    if (needed.has(name)) return;
    visiting.push(name);
    for (const dependency of registry[name].buildDependsOn || []) {
      if (!registry[dependency]) throw new Error(`BUILD INVALID: Unknown repo ${dependency} required by ${name}`);
      visit(dependency);
    }
    visiting.pop();
    needed.add(name);
  };
  for (const name of selected) visit(name);
  return [...needed];
};

const worktreeFor = ({ repo, cwd }) => {
  const receipt = readReceipt(cwd);
  const standalone = receipt?.layout === "standalone" && receipt.repos?.length === 1 && receipt.repos[0].name === repo.name;
  return standalone || repo.name === "root" ? cwd : path.resolve(cwd, repo.path);
};

export const buildClosure = ({ registry = REPOS, requested, cwd = process.cwd(), run = defaultRun, inspect = defaultInspect, report = console.log }) => {
  const order = resolveBuildOrder({ registry, requested });
  const executed = [];
  for (const name of order) {
    const repo = registry[name];
    if (repo.build === null) {
      report(`BUILD SKIPPED: ${name} — ${repo.buildSkipReason || "no build is registered"}`);
      continue;
    }
    const worktree = repo.worktree || worktreeFor({ repo, cwd });
    if (!existsSync(path.join(worktree, "node_modules"))) {
      throw new Error(`BUILD ENVIRONMENT: ${name} at ${worktree} has no node_modules. Run: node scripts/bootstrap-worktree.mjs --item <ITEM> --repos ${name}`);
    }
    const invocation = repo.build;
    report(`BUILD: ${name} (${invocation.command} ${(invocation.args || []).join(" ")})`);
    try { run(invocation.command, invocation.args || [], path.resolve(worktree, invocation.cwd || ".")); }
    catch (error) { throw new Error(`BUILD FAILURE: ${name} exited ${error?.status ?? "unknown"}.`); }
    const result = inspect({ repo, worktree });
    const problems = Array.isArray(result) ? result.flatMap((entry) => entry.problems || []) : (result.problems || []);
    if (problems.length) throw new Error(`BUILD STALE: ${name}: ${problems.join("; ")}`);
    executed.push(name);
  }
  if (executed.length === 0) throw new Error("BUILD FAILURE: built zero repos.");
  report(`BUILD COMPLETE: ${executed.length} repos — ${executed.join(" -> ")}`);
  return { order, executed };
};

export const main = () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.forText === null) throw new Error("BUILD INVALID: --for requires at least one repo name.");
  const requested = collectRepoNames(args.forText, REPO_NAMES);
  const order = resolveBuildOrder({ registry: REPOS, requested });
  if (args.list) { console.log(`BUILD ORDER: ${order.join(" -> ")}`); return 0; }
  buildClosure({ requested, report: console.log });
  return 0;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) { console.error(String(error.message || error)); process.exitCode = 1; }
}
