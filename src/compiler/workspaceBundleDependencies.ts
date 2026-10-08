import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceBundleBuild } from "../manifest/index.js";
import { SpawnfileError } from "../shared/index.js";

import { assertCommittedInputs, resolveBundleRoot, writeBundleFiles } from "./workspaceBundleFiles.js";
import { computeRecipeBundleKey, type BundleBuildContext, type BundleBuildPlan } from "./workspaceBundleKey.js";
import { bundleContainerName, runContainerStep } from "./workspaceBundleRun.js";
import { walkBuiltTree } from "./workspaceBundleTree.js";

type DependenciesSpec = NonNullable<WorkspaceBundleBuild["dependencies"]>;

const MANIFEST_LIMIT = 67_108_864;
const INSTALL_TIMEOUT_MS = 1_800_000;
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

const fail = (message: string): never => {
  throw new SpawnfileError("validation_error", message);
};

const sha256 = (bytes: Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const stable = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);

const readManifest = async (directory: string, name: string): Promise<Buffer> => {
  const file = path.join(directory, name), info = await lstat(file).catch(() => undefined);
  if (!info?.isFile() || info.size > MANIFEST_LIMIT) fail(`Dependency bundle needs a regular ${name} in ${directory}`);
  return readFile(file);
};

/**
 * The lockfile is the whole dependency identity, so it must describe exactly
 * what package.json asks for: a modern npm lock (v2+) whose root entry
 * declares the same dependency sets, with no linked (workspace or file:)
 * packages that would reach outside the install directory.
 */
export const assertNpmLockMatchesManifest = (manifestBytes: Buffer, lockBytes: Buffer, directory: string): void => {
  const parse = (bytes: Buffer, name: string): Record<string, unknown> => {
    try { return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; } catch { return fail(`Dependency bundle ${name} is not valid JSON in ${directory}`); }
  };
  const manifest = parse(manifestBytes, "package.json"), lock = parse(lockBytes, "package-lock.json");
  const packages = lock.packages as Record<string, Record<string, unknown>> | undefined;
  if (typeof lock.lockfileVersion !== "number" || lock.lockfileVersion < 2 || !packages?.[""]) fail(`Dependency bundle needs an npm lockfile v2 or later in ${directory}`);
  for (const field of DEPENDENCY_FIELDS) {
    if (stable(manifest[field] ?? {}) !== stable(packages![""]![field] ?? {})) fail(`Dependency bundle package.json ${field} differs from package-lock.json in ${directory}; run npm install`);
  }
  for (const [location, entry] of Object.entries(packages!)) {
    if (!location) continue;
    if (entry.link === true || !location.startsWith("node_modules/") || location.split("/").includes("..")) {
      fail(`Dependency bundle lock entry ${location} is linked or outside node_modules; only registry installs are archived`);
    }
    // A cold install must fetch exactly what the key names: every fetched package needs content
    // integrity, or a git source pinned to a full commit. Bundled packages ship inside their parent.
    if (entry.inBundle === true) continue;
    const resolved = typeof entry.resolved === "string" ? entry.resolved : "";
    const pinnedGit = /^git\+.+#[a-f0-9]{40}$/u.test(resolved);
    if (!pinnedGit && !validIntegrity(entry.integrity)) {
      fail(`Dependency bundle lock entry ${location} has no content integrity; its download is not pinned by the lockfile`);
    }
  }
};

// Base64 lengths of each SRI algorithm npm verifies; a token npm would parse as empty is not integrity.
const SRI_LENGTHS: Record<string, number> = { sha1: 28, sha256: 44, sha384: 64, sha512: 88 };
const validIntegrity = (value: unknown): boolean => typeof value === "string" && value.trim() !== "" &&
  value.trim().split(/\s+/u).every((token) => {
    const match = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/u.exec(token);
    return match !== null && match[2]!.length === SRI_LENGTHS[match[1]!];
  });

const inNodeModules = (relativePath: string): boolean => relativePath === "node_modules" || relativePath.startsWith("node_modules/");

/**
 * `dependencies`: package.json + package-lock.json installed with `npm ci` in
 * a digest-pinned image on the TARGET platform, so native packages and
 * platform-specific optional dependencies match the container, never the host.
 * The key is the lockfile, the manifest, the install recipe (manager, flags,
 * check command, pinned image = tool versions) and the platform; installs run
 * only on a cache miss. The archive holds the installed `node_modules` tree;
 * `.bin` symlinks and npm's hidden lockfile are left out.
 */
export const planDependenciesBundle = async (spec: DependenciesSpec, context: BundleBuildContext): Promise<BundleBuildPlan> => {
  const directory = await resolveBundleRoot(spec.directory);
  // A release build installs exactly the committed manifests.
  if (context.identity === "release") await assertCommittedInputs(directory, ["package.json", "package-lock.json"]);
  const [manifestBytes, lockBytes] = await Promise.all([readManifest(directory, "package.json"), readManifest(directory, "package-lock.json")]);
  assertNpmLockMatchesManifest(manifestBytes, lockBytes, directory);
  const dev = spec.dev ?? false, scripts = spec.scripts ?? true;
  const recipe = {
    check: spec.check ?? null, dev, image: spec.image, lock: sha256(lockBytes), manager: "npm", manifest: sha256(manifestBytes), scripts
  };
  return {
    input: "dependencies",
    key: computeRecipeBundleKey("dependencies", recipe, context.platform),
    write: async (temporaryTar) => {
      await mkdir(context.workRoot, { mode: 0o700, recursive: true });
      const work = await mkdtemp(path.join(context.workRoot, "dependencies-"));
      try {
        await copyFile(path.join(directory, "package.json"), path.join(work, "package.json"));
        await copyFile(path.join(directory, "package-lock.json"), path.join(work, "package-lock.json"));
        if (sha256(await readFile(path.join(work, "package-lock.json"))) !== recipe.lock || sha256(await readFile(path.join(work, "package.json"))) !== recipe.manifest) {
          fail(`Dependency bundle manifests changed while the bundle was built: ${directory}`);
        }
        const step = (argv: readonly string[], label: string) => runContainerStep({
          argv, dockerCommand: context.dockerCommand, env: { npm_config_cache: "/tmp/spawnfile-home/.npm", npm_config_update_notifier: "false" },
          image: spec.image, mounts: [[work, "/spawnfile/install"]], name: bundleContainerName(), platform: context.platform, workdir: "/spawnfile/install"
        }, INSTALL_TIMEOUT_MS, label, work);
        const install = ["npm", "ci", "--no-audit", "--no-fund", dev ? "--include=dev" : "--omit=dev", ...(scripts ? [] : ["--ignore-scripts"])];
        await step(install, `Dependency install for ${directory}`);
        if (spec.check) await step(spec.check, `Dependency check for ${directory}`);
        const input = await walkBuiltTree(work, {
          dropSymlink: (relativePath) => /(^|\/)\.bin\/[^/]+$/u.test(relativePath),
          skip: (relativePath) => !inNodeModules(relativePath) || relativePath === "node_modules/.package-lock.json"
        });
        return await writeBundleFiles(input, temporaryTar);
      } finally {
        await rm(work, { force: true, recursive: true });
      }
    }
  };
};
