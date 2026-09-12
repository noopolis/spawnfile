#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createAllWorktrees, worktreeLayout, worktreePath } from "./worktree-bootstrap/create.mjs";
import { worktreeRoot } from "./worktree-bootstrap/create.mjs";
import { installRepo, materializeHooks } from "./worktree-bootstrap/install.mjs";
import { INSTALL_TIERS, REPO_NAMES, REPOS, deriveMainCheckout, installTargetsFor, validateRegistry } from "./worktree-bootstrap/repos.mjs";
export { deriveMainCheckout } from "./worktree-bootstrap/repos.mjs";
import { verifyAll } from "./worktree-bootstrap/verify.mjs";
import { readReceipt, tiersFromReceipt, verifyReceipt, writeReceipt } from "./worktree-bootstrap/receipt.mjs";
import { assertExpectedCases, discoverTestFiles, parseTapSummary } from "./tap-self-test.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

export const MINIMUM_SELF_TEST_CASES = 88;
export const REQUIRED_SELF_TEST_CASE_NAMES = [
  "healthy npm receipt with three present matching packages passes",
  "symlinked package is rejected but a real package directory passes",
  "nested version mismatch is BOOTSTRAP STALE and falls back to npm-ci",
  "symlinked inherited input is BOOTSTRAP INVALID",
  "TAP parser rejects zero plan, zero passes, failures, and garbage",
  "scripts contain no absolute developer home paths",
  "hook materialization copies missing hooks and records the empirical per-worktree exclude",
  "hook verification fails closed for a missing directory and non-executable hook",
  "space-separated repos resolve to the same set as comma-separated repos",
  "repos collector stops at the next flag",
  "repos without a value fail loudly",
  "unknown space-separated repo fails loudly",
  "standalone receipt is written inside the selected repo worktree",
  "check resolution follows the receipt layout",
  "standalone create reports only existing worktree paths",
  "create rejects a missing item before resolving its worktree path",
  "build closure orders every dependency before its dependent",
  "build closure resolves transitively from a single root",
  "build closure rejects a dependency cycle by name",
  "build closure rejects an unknown repo name",
  "build closure refuses an unbootstrapped repo with the bootstrap command",
  "build closure reports a null-build repo as an explicit skip",
  "build closure fails when it would build zero repos",
  "build closure never copies a build output",
  "build closure fails a repo that builds stale output",
  "--for accepts the space form and the comma form identically"
];
export { parseTapSummary };
export const assertMinimumSelfTests = (output) => assertExpectedCases(output, { minimumCases: MINIMUM_SELF_TEST_CASES, requiredCaseNames: REQUIRED_SELF_TEST_CASE_NAMES });
const value = (args, name) => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
export const parseArgs = (args) => {
  const check = args.includes("--check"); const list = args.includes("--list");
  const reposIndex = args.indexOf("--repos");
  const repoValues = [];
  if (reposIndex >= 0) for (const arg of args.slice(reposIndex + 1)) { if (arg.startsWith("--")) break; repoValues.push(arg); }
  const reposText = reposIndex < 0 ? null : repoValues.join(",");
  return { check, list, smoke: args.includes("--smoke"), help: args.includes("--help"), full: args.includes("--full"), item: value(args, "--item"), reposText, force: args.includes("--force"), dryRun: args.includes("--dry-run"), noInstall: args.includes("--no-install"), skipSelfTest: args.includes("--skip-self-test") };
};
export const selectedRepos = (text) => {
  const names = collectRepoNames(text);
  return names?.map((name) => REPOS[name]) ?? null;
};
export const collectRepoNames = (text, validNames = REPO_NAMES) => {
  if (text === null) return null;
  if (!text) throw new Error("--repos requires at least one repo name.");
  const names = text === "all" ? validNames : text.split(",").map((name) => name.trim()).filter(Boolean);
  const unknown = names.filter((name) => !validNames.includes(name));
  if (unknown.length) throw new Error("Unknown repo " + unknown.join(", ") + "; valid repos: " + validNames.join(", ") + ", all");
  return [...new Set(names)];
};
export const discoverSelfTestFiles = (root = SCRIPT_DIRECTORY) => discoverTestFiles(root, { exclude: "loop-verify.test.mjs" });
export const createAndInstall = ({ registry = REPOS, selected, rootWorktree, item, force, mainCheckout, tiers, run, create = createAllWorktrees, install = installRepo }) => {
  const paths = create({ registry, selected, rootWorktree, item, force, mainCheckout, run });
  const hooks = {};
  for (const repo of Object.values(registry)) if (repo.hooks && paths[repo.name]) hooks[repo.name] = materializeHooks({ repo, worktree: paths[repo.name], run });
  const records = [];
  for (const repo of selected) {
    const record = install({ repo, worktree: paths[repo.name], targets: installTargetsFor(repo, { tiers }), hooks: false });
    records.push({ name: repo.name, source: repo.source, installTargets: record.targets, inherited: record.inherited, hooks: hooks[repo.name] || null });
  }
  return { paths, records };
};
export const resolveRepoPaths = ({ repos, rootWorktree, receipt }) => {
  const layout = receipt?.layout === "standalone" ? "standalone" : "nested";
  return Object.fromEntries(repos.map((repo) => [repo.name, layout === "standalone" ? rootWorktree : worktreePath({ repo, rootWorktree, layout })]));
};
const selfTest = () => {
  const files = discoverSelfTestFiles();
  if (files.length === 0) throw new Error("WORKTREE SELF-TEST FAILED: " + SCRIPT_DIRECTORY + " - discovered zero self-test files");
  const outputs = [];
  const executionErrors = [];
  for (const file of files) {
    let output = "";
    try { output = execFileSync(process.execPath, ["--test", "--test-reporter=tap", path.join(SCRIPT_DIRECTORY, file)], { cwd: path.dirname(SCRIPT_DIRECTORY), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { output = String(error.stdout || "") + String(error.stderr || ""); executionErrors.push(file + " exited " + (error.status ?? "unknown")); }
    outputs.push({ file, output });
  }
  const summaries = outputs.map(({ file, output }) => {
    const tests = output.match(/^# tests (\d+)\s*$/mu);
    const passed = output.match(/^# pass (\d+)\s*$/mu);
    const failed = output.match(/^# fail (\d+)\s*$/mu);
    if (!tests || !passed || !failed) executionErrors.push(file + " produced no complete TAP summary");
    console.log("WORKTREE SELF-TEST: " + file + " tests=" + (tests?.[1] || 0) + " pass=" + (passed?.[1] || 0) + " fail=" + (failed?.[1] || 0));
    return { tests: Number(tests?.[1] || 0), passed: Number(passed?.[1] || 0), failed: Number(failed?.[1] || 0) };
  });
  const total = summaries.reduce((sum, summary) => ({ tests: sum.tests + summary.tests, passed: sum.passed + summary.passed, failed: sum.failed + summary.failed }), { tests: 0, passed: 0, failed: 0 });
  const aggregate = outputs.map(({ output }) => output).join("\n") + "\n1.." + total.tests + "\n# pass " + total.passed + "\n# fail " + total.failed + "\n";
  console.log("WORKTREE SELF-TEST TOTAL: tests=" + total.tests + " pass=" + total.passed + " fail=" + total.failed);
  try { assertMinimumSelfTests(aggregate); parseTapSummary(aggregate); } catch (error) { throw new Error("WORKTREE SELF-TEST FAILED: " + SCRIPT_DIRECTORY + " - " + error.message + (executionErrors.length ? " (" + executionErrors.join("; ") + ")" : "")); }
  if (executionErrors.length) throw new Error("WORKTREE SELF-TEST FAILED: " + SCRIPT_DIRECTORY + " - " + executionErrors.join("; "));
};
export const resolveWorktreePath = (given, report = console.warn) => {
  const absolute = path.resolve(given);
  const real = realpathSync(absolute);
  if (absolute !== real) report("WORKTREE PATH IS AN ALIAS: " + absolute + " resolves to " + real + ". Use the resolved path — simfile's assertRegularPath walks from / and rejects /tmp and /var as symlinks.");
  return real;
};
export const isMainCheckout = ({ checkout, derive = deriveMainCheckout } = {}) => realpathSync(checkout) === realpathSync(derive({ cwd: checkout }));
export const runSmokeRepos = ({ repos, root }) => {
  const failures = [];
  let commandsRun = 0;
  for (const repo of repos) {
    const worktree = repo.name === "root" ? root : path.join(root, repo.path);
    if (!repo.smokeCommand?.length) { failures.push("WORKTREE SMOKE UNAVAILABLE: " + worktree + " has no smokeCommand."); continue; }
    for (const invocation of repo.smokeCommand) {
      commandsRun += 1;
      const cwd = path.resolve(worktree, invocation.cwd || ".");
      const started = Date.now();
      try {
        execFileSync(invocation.command, invocation.args || [], { cwd, stdio: "inherit" });
        console.log("WORKTREE SMOKE PASS: " + worktree + " " + invocation.command + " " + (invocation.args || []).join(" ") + " (" + (Date.now() - started) + "ms)");
      } catch {
        failures.push("WORKTREE SMOKE FAIL: " + worktree + " " + invocation.command + " " + (invocation.args || []).join(" ") + " (" + (Date.now() - started) + "ms)");
      }
    }
  }
  if (commandsRun === 0) failures.push("WORKTREE SMOKE FAILED: " + root + " ran zero commands.");
  return failures;
};
export const verifiedPaths = ({ repos, paths, root, check = false }) => check ? [root] : repos.map((repo) => paths[repo.name]);
const printRegistry = () => { for (const repo of Object.values(REPOS)) console.log(repo.name + "\t" + repo.kind + "\t" + repo.path + "\t" + (repo.installTargets || []).map((target) => target.path + ":" + target.tier).join(",")); };
const printUsage = () => {
  console.log("Usage: node scripts/bootstrap-worktree.mjs [options]");
  console.log("  --help                         Show this usage");
  console.log("  --list                         List registered repos");
  console.log("  --item <ID> --repos <names>    Create or plan a worktree");
  console.log("  --dry-run                      Print the plan without touching the destination");
  console.log("  --check | --smoke              Check or smoke-test an existing worktree");
  console.log("Valid repos: " + REPO_NAMES.join(", ") + ", all");
};
const printDryRun = ({ root, repos, tiers }) => {
  console.log("WORKTREE DRY RUN: destination " + root);
  for (const repo of repos) {
    const layout = worktreeLayout(repos);
    const destination = worktreePath({ repo, rootWorktree: root, layout });
    console.log("  " + repo.name + ": " + destination + " (" + (repos.some((entry) => entry.name === "root") ? "branch loop/<item>" : "detached") + ")");
    for (const target of installTargetsFor(repo, { tiers })) console.log("    install " + path.resolve(destination, target.path) + " [" + target.tier + "]");
    for (const inherited of repo.inherited || []) console.log("    inherit " + path.resolve(destination, inherited.path) + (inherited.required ? " [required]" : ""));
  }
};
export const main = () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printUsage(); return 0; }
  if (process.argv.slice(2).length === 0) { printUsage(); return 1; }
  if ([args.check, args.list, args.smoke].filter(Boolean).length > 1) throw new Error("WORKTREE INVALID: " + path.resolve(process.cwd()) + " choose only one of --check, --list, or --smoke.");
  if (args.full && (args.check || args.list || args.smoke)) throw new Error("WORKTREE INVALID: " + path.resolve(process.cwd()) + " --full is only legal on a create run.");
  const registryErrors = validateRegistry();
  if (registryErrors.length) throw new Error("WORKTREE INVALID: " + path.resolve(process.cwd()) + " registry errors: " + registryErrors.join("; "));
  if (args.skipSelfTest && !args.check) throw new Error("WORKTREE INVALID: " + path.resolve(process.cwd()) + " --skip-self-test is legal only with --check.");
  const givenRoot = process.env.PWD && realpathSync(process.env.PWD) === realpathSync(process.cwd()) ? process.env.PWD : process.cwd();
  const checkout = resolveWorktreePath(givenRoot);
  if (!args.check && !args.list && !args.smoke && !args.item) throw new Error("WORKTREE INVALID: " + path.resolve(process.cwd()) + " create runs require --item <ID>.");
  const root = args.check || args.list || args.smoke ? checkout : worktreeRoot({ item: args.item });
  if (!args.check) selfTest();
  if (args.list) { printRegistry(); return 0; }
  let selected;
  try { selected = selectedRepos(args.reposText); } catch (error) { throw new Error("WORKTREE INVALID: " + root + " " + error.message); }
  if (args.check && args.reposText && !selected) throw new Error("WORKTREE INVALID: " + path.resolve(process.cwd()) + " invalid --repos.");
  if (args.check && isMainCheckout({ checkout })) {
    console.log("WORKTREE CHECK SKIPPED: " + checkout + " is the main checkout, not a loop worktree. Nothing to verify.");
    return 0;
  }
  if (args.smoke) {
    const receipt = readReceipt(root);
    const repos = selected || (receipt?.repos || []).map((entry) => REPOS[entry.name]).filter(Boolean);
    const failures = verifyAll({ registry: REPOS, paths: {}, selected: repos, rootWorktree: root, tiers: tiersFromReceipt(receipt), checkNested: repos.some((repo) => repo.name === "root") });
    if (failures.length === 0) failures.push(...runSmokeRepos({ repos, root }));
    if (failures.length) { for (const failure of failures) console.error(failure); return 1; }
    console.log("WORKTREE SMOKE VERIFIED: " + root); return 0;
  }
  const existingReceipt = args.check ? readReceipt(root) : null;
  const receiptRepos = existingReceipt?.repos || [];
  const repos = selected || (args.check ? receiptRepos.map((entry) => REPOS[entry.name]).filter(Boolean) : [REPOS.root]);
  if (args.check && existingReceipt?.layout === "standalone") {
    const receiptRepo = receiptRepos.length === 1 ? receiptRepos[0].name : null;
    if (!receiptRepo || (selected && (selected.length !== 1 || selected[0].name !== receiptRepo))) throw new Error("WORKTREE INVALID: " + root + " standalone receipt belongs to " + (receiptRepo || "one repo") + ".");
  }
  if (!args.check && repos.some((repo) => repo.name === "stele") && !repos.some((repo) => repo.name === "root")) throw new Error("WORKTREE INVALID: " + root + " standalone stele cannot resolve its own test runner. Include root in --repos so stele is nested under a bootstrapped root worktree.");
  const tiers = args.check ? tiersFromReceipt(existingReceipt) : (args.full ? INSTALL_TIERS : ["suite"]);
  const paths = resolveRepoPaths({ repos, rootWorktree: root, receipt: existingReceipt });
  if (args.dryRun) { printDryRun({ root, repos, tiers }); return 0; }
  if (!args.check) {
    const repoRecords = [];
    const hookRecords = {};
    if (!args.dryRun && !args.noInstall) {
      const populated = createAndInstall({ registry: REPOS, selected: repos, rootWorktree: root, item: args.item, force: args.force, mainCheckout: checkout, tiers });
      Object.assign(paths, populated.paths);
      repoRecords.push(...populated.records);
    } else {
      Object.assign(paths, createAllWorktrees({ registry: REPOS, selected: repos, rootWorktree: root, item: args.item, force: args.force, mainCheckout: checkout }));
      for (const repo of Object.values(REPOS)) if (repo.hooks && paths[repo.name]) hookRecords[repo.name] = materializeHooks({ repo, worktree: paths[repo.name] });
    }
    if (!args.dryRun) {
      const layout = worktreeLayout(repos);
      const records = repoRecords.length ? repoRecords : repos.map((repo) => ({ name: repo.name, source: repo.source, installTargets: [], inherited: [], hooks: hookRecords[repo.name] || null }));
      for (const repo of repos) writeReceipt({ worktree: layout === "standalone" ? paths[repo.name] : root, item: args.item, sourceCheckout: checkout, tiers, repos: layout === "standalone" ? records.filter((record) => record.name === repo.name) : records, layout, scriptPath: fileURLToPath(import.meta.url) });
    }
  }
  const failures = verifyAll({ registry: REPOS, paths, selected: repos, rootWorktree: root, tiers, checkNested: !args.check && repos.some((repo) => repo.name === "root") || args.check && existingReceipt?.layout !== "standalone" && repos.some((repo) => repo.name === "root"), checkGitWorktree: !args.dryRun, smoke: !args.dryRun });
  if (args.check) { const receiptFailure = verifyReceipt({ worktree: root, item: args.item }); if (receiptFailure) failures.push(receiptFailure); }
  if (failures.length) { for (const failure of failures) console.error(failure); return 1; }
  const reported = verifiedPaths({ repos, paths, root, check: args.check });
  for (const worktree of reported) console.log("WORKTREE VERIFIED: " + worktree);
  return 0;
};
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); } catch (error) { const message = String(error.message || error); const caughtArgs = parseArgs(process.argv.slice(2)); const failureTarget = caughtArgs.item ? worktreeRoot({ item: caughtArgs.item }) : process.cwd(); console.error(message.startsWith("WORKTREE ") ? message : "WORKTREE FAILURE: " + path.resolve(failureTarget) + " " + message); process.exitCode = 1; }
}
