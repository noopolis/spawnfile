import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statfsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { installTargetsFor } from "./repos.mjs";
import { verifyInherited, verifyInstallTarget } from "./verify.mjs";

export const directoryBytes = (directory) => {
  if (!existsSync(directory)) return 0;
  let total = 0;
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  };
  visit(directory);
  return total;
};

export const freeBytes = (directory) => {
  const stats = statfsSync(directory, { bigint: true });
  return Number(stats.bavail * stats.bsize);
};

const gitDir = (worktree, run = (args) => execFileSync("git", args, { cwd: worktree, encoding: "utf8" }).trim()) => {
  const value = run(["-C", worktree, "rev-parse", "--git-dir"]);
  return path.resolve(worktree, value);
};

export const materializeHooks = ({ repo, worktree, run, report = console.log }) => {
  if (!repo.hooks) return { status: "not-applicable" };
  const destination = path.join(worktree, ".githooks");
  let method = "existing";
  if (!existsSync(destination)) {
    cpSync(repo.hooks.source, destination, { recursive: true });
    method = "copied";
  } else if (lstatSync(destination).isSymbolicLink() || !lstatSync(destination).isDirectory()) {
    throw new Error("WORKTREE BOOTSTRAP INVALID: " + destination + " must be a real hooks directory; refusing symlinks.");
  }
  let excluded = false;
  try {
    const exclude = path.join(gitDir(worktree, run), "info", "exclude");
    mkdirSync(path.dirname(exclude), { recursive: true });
    const existed = existsSync(exclude);
    const existing = existed ? readFileSync(exclude) : Buffer.alloc(0);
    const existingText = existing.toString("utf8");
    if (!existingText.split(/\r?\n/u).includes(".githooks/")) appendFileSync(exclude, (existingText && !existingText.endsWith("\n") ? "\n" : "") + ".githooks/\n");
    try {
      execFileSync("git", ["-C", worktree, "check-ignore", "--no-index", ".githooks/pre-commit"], { stdio: "ignore" }); excluded = true;
    } catch {
      if (existed) writeFileSync(exclude, existing); else if (existsSync(exclude)) unlinkSync(exclude);
    }
  } catch { /* shared git metadata may be unavailable; the copy remains auditable */ }
  const record = { path: ".githooks", method, expected: repo.hooks.expected, excluded };
  report("WORKTREE HOOKS: " + path.resolve(worktree) + " " + method + " .githooks/ (per-worktree exclude " + (excluded ? "works" : "did not apply") + ")");
  return record;
};

export const cloneDirectory = (source, destination, report = console.warn) => {
  try {
    execFileSync("cp", ["-c", "-R", source, destination], { stdio: "pipe" });
    return { clonefile: true };
  } catch {
    report("WORKTREE POPULATE WARNING: " + destination + " filesystem does not support clonefile; falling back to cp -R from " + source + ".");
    rmSync(destination, { recursive: true, force: true });
    execFileSync("cp", ["-R", source, destination], { stdio: "pipe" });
    return { clonefile: false };
  }
};

const defaultNpmInstall = (targetPath) => {
  execFileSync("npm", ["ci", "--prefer-offline", "--no-audit", "--fund=false"], { cwd: targetPath, stdio: "inherit" });
};

export const populateInstallTarget = ({
  repo,
  worktree,
  target,
  clone = cloneDirectory,
  npmInstall = defaultNpmInstall,
  getFreeBytes = freeBytes,
  now = Date.now,
  report = console.log
}) => {
  const targetPath = path.resolve(worktree, target.path);
  const sourceModules = path.resolve(repo.source, target.path, "node_modules");
  const targetModules = path.join(targetPath, "node_modules");
  mkdirSync(targetPath, { recursive: true });
  const cloneStarted = now();
  const cloneFreeBefore = getFreeBytes(targetPath);
  let reason;
  if (existsSync(sourceModules) && lstatSync(sourceModules).isDirectory() && !lstatSync(sourceModules).isSymbolicLink()) {
    rmSync(targetModules, { recursive: true, force: true });
    clone(sourceModules, targetModules);
    if (!existsSync(targetModules) || lstatSync(targetModules).isSymbolicLink() || !lstatSync(targetModules).isDirectory()) {
      throw new Error("WORKTREE BOOTSTRAP INVALID: " + targetModules + " is not a real directory after clone. Never symlink node_modules.");
    }
    const verification = verifyInstallTarget({ repo, worktree, target, smoke: false });
    if (verification.failures.length === 0) {
      const elapsedMs = now() - cloneStarted;
      const diskDeltaBytes = Math.max(0, cloneFreeBefore - getFreeBytes(targetPath));
      report("WORKTREE POPULATE: " + targetPath + " cloned (" + verification.requiredPackages + " packages, " + elapsedMs + "ms, " + diskDeltaBytes + " bytes)");
      return { path: target.path, tier: target.tier, method: "clone", packages: verification.requiredPackages, elapsedMs, diskDeltaBytes };
    }
    reason = verification.failures[0];
  } else {
    reason = "main checkout has no reusable node_modules at " + sourceModules;
  }
  rmSync(targetModules, { recursive: true, force: true });
  report("WORKTREE POPULATE: " + targetPath + " could not reuse the main checkout's node_modules (" + reason + "); running npm ci instead.");
  const npmStarted = now();
  const npmFreeBefore = getFreeBytes(targetPath);
  try { npmInstall(targetPath); } catch (error) {
    const status = error?.status ?? "unknown";
    const message = "WORKTREE POPULATE FAILED: npm ci in " + targetPath + " exited " + status + ". The output above is npm's, not the product's. This is an environment defect.";
    report(message);
    throw new Error(message);
  }
  const verification = verifyInstallTarget({ repo, worktree, target, smoke: false });
  if (verification.failures.length) throw new Error(verification.failures.join("\n"));
  const elapsedMs = now() - npmStarted;
  const diskDeltaBytes = Math.max(0, npmFreeBefore - getFreeBytes(targetPath));
  report("WORKTREE POPULATE: " + targetPath + " npm-ci (" + verification.requiredPackages + " packages, " + elapsedMs + "ms, " + diskDeltaBytes + " bytes)");
  return { path: target.path, tier: target.tier, method: "npm-ci", packages: verification.requiredPackages, elapsedMs, diskDeltaBytes, reason };
};

export const populateInherited = ({
  repo,
  worktree,
  entry,
  clone = cloneDirectory,
  now = Date.now,
  report = console.log
}) => {
  const source = path.resolve(repo.source, entry.path);
  const destination = path.resolve(worktree, entry.path);
  if (!existsSync(source)) {
    const failure = verifyInherited({ repo, worktree, entry }).failures[0];
    if (failure) throw new Error(failure);
    return null;
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  rmSync(destination, { recursive: true, force: true });
  const started = now();
  clone(source, destination);
  const verification = verifyInherited({ repo, worktree, entry });
  if (verification.failures.length) throw new Error(verification.failures.join("\n"));
  const elapsedMs = now() - started;
  const record = { path: entry.path, bytes: directoryBytes(destination), entries: verification.entries, elapsedMs };
  report("WORKTREE INHERITED: " + destination + " cloned (" + record.entries + " entries, " + elapsedMs + "ms, " + record.bytes + " logical bytes)");
  return record;
};

export const installRepo = ({ repo, worktree, targets = installTargetsFor(repo), dependencies = {}, hooks = true }) => {
  const records = [];
  const hookRecord = hooks ? materializeHooks({ repo, worktree, ...dependencies }) : null;
  for (const target of targets) records.push(populateInstallTarget({ repo, worktree, target, ...dependencies }));
  const inherited = [];
  for (const entry of repo.inherited || []) {
    const record = populateInherited({ repo, worktree, entry, ...dependencies });
    if (record) inherited.push(record);
  }
  if (repo.kind === "node") console.log(repo.name + ": dist absent - run npm run build before judging any packaged test (LOOP RULE 5)");
  return { targets: records, inherited, hooks: hookRecord };
};
