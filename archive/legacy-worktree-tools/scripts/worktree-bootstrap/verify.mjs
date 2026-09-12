import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, readlinkSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { installTargetsFor } from "./repos.mjs";

const prefix = (text) => "WORKTREE " + text;
const defaultGitRun = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const readLock = (lockPath) => JSON.parse(readFileSync(lockPath, "utf8"));
const pathComponents = (target) => {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const result = [parsed.root];
  let current = parsed.root;
  for (const part of parts) { current = path.join(current, part); result.push(current); }
  return result;
};

export const findSymlink = (target, boundary = path.parse(path.resolve(target)).root) => {
  const boundaryPath = path.resolve(boundary);
  for (const component of pathComponents(target)) {
    if (component !== boundaryPath && !component.startsWith(boundaryPath + path.sep)) continue;
    try { if (lstatSync(component).isSymbolicLink()) return component; } catch { break; }
  }
  return null;
};

export const verifyInstallTarget = ({ repo, worktree, target, smoke = true }) => {
  const failures = [];
  const targetPath = path.resolve(worktree, target.path);
  const modules = path.join(targetPath, "node_modules");
  const result = { failures, requiredPackages: 0, missingPackages: 0, targetPath };
  if (!existsSync(modules)) {
    failures.push(prefix("NOT BOOTSTRAPPED: " + targetPath + " has no node_modules. This is an environment defect, not a product defect. Run: node scripts/bootstrap-worktree.mjs --item <ITEM> --repos " + repo.name));
    return result;
  }
  const symlink = findSymlink(modules, worktree);
  if (symlink) {
    failures.push(prefix("BOOTSTRAP INVALID: " + symlink + " is a symlink. simfile's assertRegularPath rejects every symlinked path component (buildReceiptLockPath.ts:112) and the fixture ownership census requires a real directory. Never symlink node_modules; re-run bootstrap."));
    return result;
  }
  if (!statSync(modules).isDirectory()) {
    failures.push(prefix("BOOTSTRAP INVALID: " + modules + " is not a directory."));
    return result;
  }
  const receiptPath = path.join(modules, ".package-lock.json");
  if (!existsSync(receiptPath)) {
    failures.push(prefix("NOT BOOTSTRAPPED: " + targetPath + " has no node_modules/.package-lock.json, so npm never completed an install here. This is an environment defect, not a product defect. Run: node scripts/bootstrap-worktree.mjs --item <ITEM> --repos " + repo.name));
    return result;
  }
  let receipt;
  try { receipt = readLock(receiptPath); } catch {
    failures.push(prefix("BOOTSTRAP INVALID: " + receiptPath + " is not valid JSON. Re-run bootstrap."));
    return result;
  }
  const receiptEntries = Object.entries(receipt.packages || {});
  const installed = receiptEntries.filter(([key, value]) => /^node_modules\//u.test(key) && value?.optional !== true && value?.devOptional !== true);
  result.requiredPackages = installed.length;
  if (installed.length === 0) failures.push(prefix("BOOTSTRAP INCOMPLETE: " + targetPath + " node_modules/.package-lock.json records zero required packages. Re-run bootstrap; do not debug the code."));
  const missing = [];
  const packageHusks = [];
  for (const [key] of installed) {
    const packagePath = path.join(targetPath, key);
    let packageStat;
    try { packageStat = lstatSync(packagePath); } catch { missing.push([key]); continue; }
    const recordedPackage = receipt.packages[key];
    if (packageStat.isSymbolicLink()) {
      if (recordedPackage?.link === true) {
        // The root install's own workspace links point at ../../ecosystem/<name>; nesting those worktrees is required, not merely convenient.
        try {
          const resolved = realpathSync(packagePath);
          if (!statSync(resolved).isDirectory()) throw new Error("not a directory");
        } catch {
          const linkTarget = path.resolve(path.dirname(packagePath), readlinkSync(packagePath));
          failures.push(prefix("INCOMPLETE: " + packagePath + " is an npm workspace link to " + linkTarget + ", which does not exist. The root repo excludes /ecosystem, so a root worktree has no ecosystem until bootstrap nests one. This is an environment defect, not a product defect."));
        }
      } else failures.push(prefix("BOOTSTRAP INVALID: " + packagePath + " is a symlink inside node_modules. simfile's assertRegularDirectory walks node_modules/esbuild and node_modules/typescript (buildReceiptLockAuthority.ts:256) and rejects every symlinked component. Re-run bootstrap."));
    } else if (!packageStat.isDirectory()) missing.push([key]);
    else if (recordedPackage?.link !== true && !existsSync(path.join(packagePath, "package.json"))) packageHusks.push(key);
  }
  result.missingPackages = missing.length;
  if (missing.length) {
    if (repo.name === "stele" && missing.length === installed.length) {
      failures.push(prefix("BOOTSTRAP INCOMPLETE: " + targetPath + " is missing " + missing.length + " of " + installed.length + " packages npm recorded installing. Its tests may still pass by resolving up into the root checkout's node_modules, which is a false green."));
    } else {
      failures.push(prefix("BOOTSTRAP INCOMPLETE: " + targetPath + " is missing " + missing.length + " of " + installed.length + " packages npm recorded installing (first missing: " + missing[0][0] + "). Re-run bootstrap; do not debug the code."));
    }
  }
  if (packageHusks.length) failures.push(prefix("BOOTSTRAP INCOMPLETE: " + targetPath + " has " + packageHusks.length + " package directories with no package.json (first: " + packageHusks[0] + ")"));
  const projectLockPath = path.join(targetPath, "package-lock.json");
  if (existsSync(projectLockPath)) {
    let projectLock;
    try { projectLock = readLock(projectLockPath); } catch {
      failures.push(prefix("BOOTSTRAP INVALID: " + projectLockPath + " is not valid JSON. Re-run bootstrap."));
    }
    if (projectLock) {
      const requiredKeys = (packages) => new Set(Object.entries(packages || {}).filter(([key, value]) => /^node_modules\//u.test(key) && value?.optional !== true && value?.devOptional !== true).map(([key]) => key));
      const receiptKeys = requiredKeys(receipt.packages);
      const projectKeys = requiredKeys(projectLock.packages);
      const missingFromReceipt = [...projectKeys].find((key) => !receiptKeys.has(key));
      const missingFromProject = [...receiptKeys].find((key) => !projectKeys.has(key));
      if (missingFromReceipt) failures.push(prefix("BOOTSTRAP STALE: " + targetPath + " receipt is missing required package " + missingFromReceipt + " present in package-lock.json. Re-run bootstrap."));
      else if (missingFromProject) failures.push(prefix("BOOTSTRAP STALE: " + targetPath + " package-lock.json is missing required package " + missingFromProject + " present in the npm receipt. Re-run bootstrap."));
      for (const key of receiptKeys) {
        const installedPackage = receipt.packages[key];
        const wanted = projectLock.packages[key];
        if (wanted && installedPackage.version !== wanted.version) failures.push(prefix("BOOTSTRAP STALE: " + targetPath + "/node_modules was installed from a different lock (" + key + " installed " + installedPackage.version + ", package-lock.json wants " + wanted.version + "). Re-run bootstrap."));
      }
    }
  }
  if (target.bin) {
    const bin = path.resolve(worktree, target.bin);
    if (!existsSync(bin) || !statSync(bin).isFile()) failures.push(prefix("BOOTSTRAP INCOMPLETE: " + bin + " is missing or not a file."));
  }
  if (smoke && target.smoke) {
    try { createRequire(path.join(targetPath, "package.json")).resolve(target.smoke); }
    catch { failures.push(prefix("BOOTSTRAP INVALID: " + targetPath + " cannot resolve " + target.smoke + ".")); }
  }
  return result;
};

export const verifyInherited = ({ repo, worktree, entry }) => {
  const failures = [];
  const targetPath = path.resolve(worktree, entry.path);
  const sourcePath = path.resolve(repo.source, entry.path);
  if (!existsSync(sourcePath)) {
    if (entry.required) failures.push(prefix("SOURCE INCOMPLETE: " + targetPath + " cannot inherit from missing source " + sourcePath + ". The main checkout is missing required gitignored input."));
    return { failures, entries: 0, sourceEntries: 0 };
  }
  const sourceEntries = statSync(sourcePath).isDirectory() ? readdirSync(sourcePath).length : 0;
  if (!existsSync(targetPath)) {
    if (entry.required) failures.push(prefix("NOT BOOTSTRAPPED: " + targetPath + " is absent. It is gitignored, so git never puts it in a worktree; the build needs it. This is an environment defect, not a product defect."));
    return { failures, entries: 0, sourceEntries };
  }
  const targetStat = lstatSync(targetPath);
  if (targetStat.isSymbolicLink()) {
    failures.push(prefix("BOOTSTRAP INVALID: " + targetPath + " is a symlink. Gitignored content must be copied, not linked: assertRegularPath rejects every symlinked path component."));
    return { failures, entries: 0, sourceEntries };
  }
  const entries = targetStat.isDirectory() ? readdirSync(targetPath).length : 0;
  if (!targetStat.isDirectory() || entries === 0 || entries !== sourceEntries) {
    failures.push(prefix("BOOTSTRAP INCOMPLETE: " + targetPath + " has " + entries + " of " + sourceEntries + " top-level entries the main checkout has. Re-run bootstrap; do not debug the code."));
  }
  return { failures, entries, sourceEntries };
};

const checkGit = ({ repo, worktree, failures, gitRun = defaultGitRun }) => {
  try {
    const top = gitRun(["-C", worktree, "rev-parse", "--show-toplevel"], worktree);
    if (path.resolve(top) !== path.resolve(worktree)) failures.push(prefix("INVALID: " + worktree + " is not the expected git worktree."));
    const common = realpathSync(path.resolve(worktree, gitRun(["-C", worktree, "rev-parse", "--git-common-dir"], worktree)));
    const expected = realpathSync(path.join(repo.source, ".git"));
    if (common !== expected) failures.push(prefix("INVALID: " + worktree + " git common dir is " + common + "; expected source repository " + expected + "."));
  } catch { failures.push(prefix("INCOMPLETE: " + worktree + " is not a git worktree.")); }
  if (!existsSync(repo.source)) failures.push(prefix("INCOMPLETE: source checkout " + repo.source + " for " + repo.name + " is absent."));
};

export const verifyHooks = ({ repo, worktree, gitRun = defaultGitRun }) => {
  const failures = [];
  if (!repo.hooks) return { failures, checked: 0 };
  let hooksPath;
  try { hooksPath = gitRun(["-C", worktree, "config", "--get", "core.hooksPath"], worktree); }
  catch { failures.push(prefix("INCOMPLETE: " + path.resolve(worktree) + " core.hooksPath is unset; hooks cannot be effective.")); return { failures, checked: 1 }; }
  const directory = path.isAbsolute(hooksPath) ? hooksPath : path.resolve(worktree, hooksPath);
  let directoryStat;
  try { directoryStat = lstatSync(directory); } catch { directoryStat = null; }
  if (!directoryStat || !directoryStat.isDirectory()) {
    failures.push(prefix("INCOMPLETE: " + path.resolve(worktree) + " core.hooksPath " + hooksPath + " does not resolve to an existing directory from this worktree."));
    return { failures, checked: 1 };
  }
  for (const name of repo.hooks.expected || []) {
    const hook = path.join(directory, name);
    let hookStat;
    try { hookStat = lstatSync(hook); } catch { hookStat = null; }
    if (!hookStat || !hookStat.isFile()) {
      failures.push(prefix("INCOMPLETE: " + path.resolve(worktree) + " hooks directory is missing expected executable hook " + hook + "."));
    } else if ((hookStat.mode & 0o111) === 0) {
      failures.push(prefix("INVALID: " + path.resolve(worktree) + " hook " + hook + " exists but is not executable."));
    }
  }
  return { failures, checked: 1 };
};

export const verifyRepo = ({ repo, worktree, rootWorktree, registry, targets = repo.installTargets || [], checkNested = true, checkGitWorktree = true, smoke = true, gitRun = defaultGitRun, hookResult = verifyHooks({ repo, worktree, gitRun }) }) => {
  const failures = [];
  if (checkGitWorktree) checkGit({ repo, worktree, failures, gitRun });
  failures.push(...hookResult.failures);
  for (const target of targets) failures.push(...verifyInstallTarget({ repo, worktree, target, smoke }).failures);
  for (const entry of repo.inherited || []) failures.push(...verifyInherited({ repo, worktree, entry }).failures);
  if (checkNested && repo.name === "root") for (const nested of Object.values(registry)) if (nested.name !== "root") {
    const nestedPath = path.join(rootWorktree, nested.path);
    if (!existsSync(nestedPath)) failures.push(prefix("INCOMPLETE: " + nestedPath + " is absent. The root repo excludes /ecosystem, so a root worktree has no ecosystem until bootstrap nests one."));
    else checkGit({ repo: nested, worktree: nestedPath, failures, gitRun });
  }
  return failures;
};

export const verifyAll = ({ registry, paths, selected, rootWorktree, tiers = ["suite"], checkNested = true, checkGitWorktree = true, smoke = true, gitRun = defaultGitRun, verifyHook = verifyHooks }) => {
  const failures = [];
  let checkedHooks = 0;
  if (!selected.length) failures.push(prefix("INCOMPLETE: " + path.resolve(rootWorktree) + " declares zero repositories; verification is non-vacuous."));
  for (const repo of selected) {
    const worktree = paths[repo.name] || (repo.name === "root" ? rootWorktree : path.join(rootWorktree, repo.path));
    const targets = installTargetsFor(repo, { tiers });
    if (targets.length === 0 && repo.kind !== "go") failures.push(prefix("INCOMPLETE: " + worktree + " declares zero install targets; verification is non-vacuous."));
    if (repo.kind === "go" && targets.length === 0) {
      if (!existsSync(worktree)) failures.push(prefix("INCOMPLETE: " + worktree + " does not exist."));
      if (!repo.smokeCommand?.length) failures.push(prefix("INCOMPLETE: " + worktree + " declares no smokeCommand in the runtime registry."));
    }
    const hookResult = verifyHook({ repo, worktree, gitRun });
    checkedHooks += hookResult.checked;
    failures.push(...verifyRepo({ repo, worktree, rootWorktree, registry, targets, checkNested: checkNested && repo.name === "root", checkGitWorktree, smoke, gitRun, hookResult }));
  }
  const hookRepos = selected.filter((repo) => repo.hooks);
  if (hookRepos.length > 0 && checkedHooks === 0) failures.push(prefix("INCOMPLETE: " + path.resolve(rootWorktree) + " declares hook-bearing repositories but verified zero hook repositories; verification is non-vacuous."));
  return failures;
};
