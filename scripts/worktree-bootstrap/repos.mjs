import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
export const deriveMainCheckout = ({ cwd = repoRoot, sourceHome = process.env.SPAWNFILE_SOURCE_HOME } = {}) => {
  const attempt = sourceHome ? path.resolve(sourceHome, "spawnfile") : "git common directory from " + path.resolve(cwd);
  try {
    if (sourceHome) return realpathSync(attempt);
    const common = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
    const commonPath = realpathSync(common);
    return realpathSync(path.basename(commonPath) === ".git" ? path.dirname(commonPath) : commonPath);
  } catch (error) {
    throw new Error("WORKTREE SOURCE DERIVATION FAILED: tried " + attempt + " (" + String(error.message || error) + ").");
  }
};
const sourceRoot = deriveMainCheckout();
const sourcePath = (relative = ".") => {
  const candidate = path.resolve(sourceRoot, relative);
  if (!existsSync(candidate)) throw new Error("WORKTREE SOURCE MISSING: " + candidate + " (derived from " + sourceRoot + ") does not exist. Check the root checkout and ecosystem repositories.");
  return realpathSync(candidate);
};
const target = (targetPath, tier, options = {}) => ({ path: targetPath, tier, ...options });
const hooksFromSource = (source) => {
  const directory = path.join(source, ".githooks");
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return null;
  const expected = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.endsWith(".mjs"))
    .map((entry) => entry.name).sort();
  return { source: directory, expected };
};

export const REPO_NAMES = ["root", "simfile", "daimon", "mneme", "moltnet", "stele"];
export const INSTALL_TIERS = ["suite", "extra"];

export const REPOS = {
  root: {
    name: "root",
    displayName: "spawnfile",
    path: ".",
    kind: "node",
    source: sourcePath(),
    hooks: hooksFromSource(sourcePath()),
    installTargets: [target(".", "suite", { bin: "node_modules/.bin/vitest", smoke: "vitest" })],
    smokeCommand: [{ command: "npx", args: ["vitest", "run", "--coverage.enabled=false", "src/ownership/rootOwnershipBoundary.test.ts"], cwd: "." }],
    build: { command: "npm", args: ["run", "build"], cwd: "." },
    buildDependsOn: [],
    suite: "npm test"
  },
  simfile: {
    name: "simfile",
    path: "ecosystem/simfile",
    kind: "node",
    source: sourcePath("ecosystem/simfile"),
    hooks: hooksFromSource(sourcePath("ecosystem/simfile")),
    installTargets: [
      target(".", "suite", { bin: "node_modules/.bin/tsx", smoke: "tsx" }),
      target("website", "extra", { smoke: "tsx" })
    ],
    smokeCommand: [{ command: "node", args: ["--import", "tsx", "--test", "src/runtime/autonomyBoundary.test.ts"], cwd: "." }],
    build: { command: "npm", args: ["run", "build"], cwd: "." },
    buildDependsOn: [],
    suite: "node --import tsx --test src/**/*.test.ts web/src/**/*.test.ts"
  },
  daimon: {
    name: "daimon",
    path: "ecosystem/daimon",
    kind: "node",
    source: sourcePath("ecosystem/daimon"),
    installTargets: [target(".", "suite", { bin: "node_modules/.bin/tsx", smoke: "tsx" })],
    smokeCommand: [{ command: "node", args: ["--import", "tsx", "--test", "src/pi/turnCausal.test.ts"], cwd: "." }],
    build: { command: "npm", args: ["run", "build"], cwd: "." },
    buildDependsOn: ["mneme"],
    suite: "node --import tsx --test src/**/*.test.ts"
  },
  mneme: {
    name: "mneme",
    path: "ecosystem/mneme",
    kind: "node",
    source: sourcePath("ecosystem/mneme"),
    installTargets: [target(".", "suite", { bin: "node_modules/.bin/tsx", smoke: "tsx" })],
    smokeCommand: [{ command: "node", args: ["--import", "tsx", "--test", "src/identity/scope.test.ts"], cwd: "." }],
    build: { command: "npm", args: ["run", "build"], cwd: "." },
    buildDependsOn: [],
    suite: "node --import tsx --test src/**/*.test.ts"
  },
  moltnet: {
    name: "moltnet",
    path: "ecosystem/moltnet",
    kind: "go",
    source: sourcePath("ecosystem/moltnet"),
    installTargets: [
      target("relay", "suite"),
      target("web", "extra"),
      target("website", "extra")
    ],
    smokeCommand: [
      { command: "go", args: ["build", "./..."], cwd: "." },
      { command: "node", args: ["--test", "test/golden-frames.test.mjs"], cwd: "relay" }
    ],
    build: null,
    buildDependsOn: [],
    buildSkipReason: "Moltnet build is Docker-based and this worktree uses a remote SSH Docker context.",
    suite: "make test"
  },
  stele: {
    name: "stele",
    path: "ecosystem/stele",
    kind: "node",
    source: sourcePath("ecosystem/stele"),
    installTargets: [target(".", "suite", { bin: "node_modules/.bin/vitest", smoke: "vitest" })],
    smokeCommand: [{ command: "npx", args: ["vitest", "run", "src/seq.test.ts"], cwd: "." }],
    build: { command: "npm", args: ["run", "build"], cwd: "." },
    buildDependsOn: [],
    suite: "vitest run",
    knownRed: true
  }
};

export const repoRootPath = repoRoot;
export const getRepo = (name) => REPOS[name];
export const installTargetsFor = (repo, { full = false, tiers } = {}) => {
  const selectedTiers = new Set(tiers || (full ? INSTALL_TIERS : ["suite"]));
  return (repo.installTargets || []).filter((entry) => selectedTiers.has(entry.tier || "suite"));
};
export const validateRegistry = (registry = REPOS) => {
  const errors = [];
  for (const [name, repo] of Object.entries(registry)) {
    if (repo.kind !== "go" && (!Array.isArray(repo.installTargets) || repo.installTargets.length === 0)) errors.push(name + ": node repo has no install targets");
    for (const entry of [...(repo.installTargets || []), ...(repo.inherited || [])]) {
      if (!entry.path || path.posix.isAbsolute(entry.path) || entry.path.includes("\\") || entry.path.split("/").includes("..")) errors.push(name + ": invalid relative path " + entry.path);
    }
    for (const entry of repo.installTargets || []) if (!INSTALL_TIERS.includes(entry.tier)) errors.push(name + ": invalid install tier " + entry.tier);
  }
  return errors;
};
