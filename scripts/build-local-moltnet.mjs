#!/usr/bin/env node
// Produces an explicit local-development Moltnet archive. Production staging
// never consults this output or a sibling checkout.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateSourceBundle } from "./source-provenance-bundle.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configuredMoltnetSource = process.env.SPAWNFILE_MOLTNET_SOURCE_DIR?.trim();
const moltnetDir = configuredMoltnetSource
  ? path.resolve(configuredMoltnetSource)
  : path.resolve(repoRoot, "..", "moltnet");
const configuredReleaseOutput = process.env.SPAWNFILE_MOLTNET_LOCAL_RELEASE_OUTPUT?.trim();
const releaseDir = configuredReleaseOutput ? path.resolve(configuredReleaseOutput) : path.join(moltnetDir, "dist", "spawnfile-local-release");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export const goarchForHost = () => {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "amd64";
  throw new Error(`Unsupported host architecture for local Moltnet build: ${process.arch}`);
};

export const goarchForTarget = () => {
  const requested = process.env.MOLTNET_TARGET_GOARCH;
  if (requested === undefined) return goarchForHost();
  if (requested !== "amd64" && requested !== "arm64") throw new Error(`Unsupported MOLTNET_TARGET_GOARCH: ${requested}`);
  return requested;
};

const normalizedTrackedPath = (root, relativePath) => {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error("Tracked source path must be relative");
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Tracked source path escapes its root: ${relativePath}`);
  }
  return { relative: relative.split(path.sep).join("/"), resolved };
};

const containedSymlink = (root, linkPath) => {
  const link = readlinkSync(linkPath);
  if (!link || path.isAbsolute(link)) throw new Error(`Tracked symlink must be nonempty and relative: ${linkPath}`);
  const target = path.resolve(path.dirname(linkPath), link);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Tracked symlink escapes its source root: ${linkPath}`);
  }
  return { link, target: relative.split(path.sep).join("/") };
};

/** Hash Git-tracked entries without dereferencing links. The link text and
 * in-tree target identity are both bound, so tracked CLAUDE.md symlinks are
 * accepted deterministically but cannot introduce an out-of-tree read. */
export const hashTrackedSourceEntries = (root, entries) => {
  const digest = createHash("sha256");
  const ordered = [...entries].sort((left, right) => left.path.localeCompare(right.path));
  const trackedPaths = new Set(ordered.map((entry) => normalizedTrackedPath(root, entry.path).relative));
  for (const entry of ordered) {
    const { relative, resolved } = normalizedTrackedPath(root, entry.path);
    const stats = lstatSync(resolved);
    if (entry.mode === "120000") {
      if (!stats.isSymbolicLink()) throw new Error(`Tracked symlink changed type: ${relative}`);
      const target = containedSymlink(root, resolved);
      if (!trackedPaths.has(target.target)) {
        throw new Error(`Tracked symlink target is not a tracked in-tree source entry: ${relative}`);
      }
      digest.update(`symlink\0${relative}\0${target.link}\0${target.target}\0`);
      continue;
    }
    if ((entry.mode !== "100644" && entry.mode !== "100755") || !stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Unsupported tracked source entry: ${relative}`);
    }
    digest.update(`file\0${entry.mode}\0${relative}\0`);
    digest.update(readFileSync(resolved));
    digest.update("\0");
  }
  return `sha256:${digest.digest("hex")}`;
};

const readTrackedEntries = (root) => execFileSync("git", ["-C", root, "ls-files", "-s", "-z"], { encoding: "utf8" })
  .split("\0").filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t");
    const [mode] = entry.slice(0, tab).split(" ");
    if (!mode || tab < 0) throw new Error("Unable to parse tracked source entry");
    return { mode, path: entry.slice(tab + 1) };
  });

const assertCleanSource = (root) => {
  const status = execFileSync("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" });
  if (status.trim()) throw new Error("Local Moltnet build requires a clean source tree");
};

export const createCapabilityProbeConfig = (kind, receiptStorePath) => ({
  version: "moltnet.node.v1",
  moltnet: { base_url: "http://127.0.0.1:9", network_id: "capability" },
  attachments: [{ agent: { id: `${kind}-agent`, name: `${kind} agent` }, runtime: kind === "daimon"
    ? { kind, control_url: "http://127.0.0.1:19700", receipt_store_path: receiptStorePath, token_env: "SPAWNFILE_DAIMON_CONTROL_TOKEN" }
    : { kind, control_url: "http://127.0.0.1:19690/agents/pi-agent/wake" } }]
});

const assertBuiltBinaryCapabilities = (binaryPath) => {
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "spawnfile-moltnet-capability-"));
  try {
    for (const kind of ["pi", "daimon"]) {
      const configPath = path.join(temporaryDirectory, `${kind}.json`);
      const receiptDirectory = path.join(temporaryDirectory, "daimon-receipts");
      mkdirSync(receiptDirectory, { mode: 0o700, recursive: true });
      writeFileSync(configPath, JSON.stringify(createCapabilityProbeConfig(
        kind,
        path.join(receiptDirectory, `${kind}-agent.json`)
      )));
      const result = spawnSync(binaryPath, ["node", configPath], {
        encoding: "utf8", env: { ...process.env, SPAWNFILE_DAIMON_CONTROL_TOKEN: "local-capability-probe" }, timeout: 1_000
      });
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      if (result.error?.code === "ETIMEDOUT") continue; // parser accepted; the endpoint is deliberately unreachable.
      if (/unsupported|only supported|required|invalid/i.test(output)) {
        throw new Error(`Built Moltnet binary does not accept ${kind}-bridge: ${output.trim()}`);
      }
      if (result.status !== null && /connection refused|connect:|dial tcp|network is unreachable/i.test(output)) continue;
      throw new Error(`Built Moltnet binary could not be probed for ${kind}-bridge`);
    }
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
};

const assertDockerBinaryCapabilities = (binaryPath) => {
  for (const kind of ["pi", "daimon"]) {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "spawnfile-moltnet-probe-")), configPath = path.join(temporaryDirectory, "config.json"), receiptDirectory = path.join(temporaryDirectory, "receipts"); mkdirSync(receiptDirectory);
    writeFileSync(configPath, JSON.stringify(createCapabilityProbeConfig(kind, "/receipts/agent.json")));
    const id = execFileSync("docker", ["create", "--platform", "linux/amd64", "--env", "SPAWNFILE_DAIMON_CONTROL_TOKEN=probe", "node:24-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df", "timeout", "2", "/moltnet", "node", "/config.json"], { encoding: "utf8" }).trim();
    try { execFileSync("docker", ["cp", binaryPath, `${id}:/moltnet`]); execFileSync("docker", ["cp", configPath, `${id}:/config.json`]); execFileSync("docker", ["cp", receiptDirectory, `${id}:/receipts`]); const result = spawnSync("docker", ["start", "--attach", id], { encoding: "utf8" }); const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`; if (result.status !== 124 && !/connection refused|connect:|dial tcp|network is unreachable/iu.test(output)) throw new Error(`Built Moltnet binary does not accept ${kind}-bridge: ${output.trim()}`); }
    finally { execFileSync("docker", ["rm", "--force", id], { stdio: "ignore" }); rmSync(temporaryDirectory, { force: true, recursive: true }); }
  }
};

const requiredBundle = (name, profile) => {
  const value = process.env[name]?.trim(); if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute provenance archive`);
  const item = lstatSync(value); if (!item.isFile() || item.isSymbolicLink() || !item.size) throw new Error(`${name} must be a nonempty regular file`);
  const receipt = validateSourceBundle(readFileSync(value)); if (receipt.manifest.exclude_policy.profile !== profile) throw new Error(`${name} has the wrong provenance profile`); return { ...receipt, path: value };
};

const main = () => {
  if (configuredMoltnetSource && !path.isAbsolute(configuredMoltnetSource)) {
    throw new Error("SPAWNFILE_MOLTNET_SOURCE_DIR must be absolute");
  }
  if (configuredReleaseOutput && (!path.isAbsolute(configuredReleaseOutput) || path.resolve(configuredReleaseOutput) !== configuredReleaseOutput)) throw new Error("SPAWNFILE_MOLTNET_LOCAL_RELEASE_OUTPUT must be normalized absolute");
  const archiveMode = Boolean(process.env.SPAWNFILE_MOLTNET_SOURCE_BUNDLE || process.env.SPAWNFILE_MOLTNET_GO_DEPENDENCY_BUNDLE);
  if (!archiveMode && !existsSync(path.join(moltnetDir, ".git"))) throw new Error(`Missing sibling Moltnet checkout: ${moltnetDir}`);
  if (!archiveMode) assertCleanSource(moltnetDir);
  const arch = goarchForTarget();
  if (!archiveMode && arch !== goarchForHost()) throw new Error("Cross-compiled local archives cannot prove their binary capabilities on this host");
  const workDirectory = mkdtempSync(path.join(os.tmpdir(), "spawnfile-moltnet-build-"));
  const binaryPath = path.join(workDirectory, "moltnet");
  const asset = `moltnet_linux_${arch}.tar.gz`;
  const assetPath = path.join(releaseDir, asset);
  try {
    if (archiveMode) {
      if (arch !== "amd64") throw new Error("Moltnet archive provenance supports only linux/amd64");
      const source = requiredBundle("SPAWNFILE_MOLTNET_SOURCE_BUNDLE", "build-source"), dependencies = requiredBundle("SPAWNFILE_MOLTNET_GO_DEPENDENCY_BUNDLE", "go-dependencies"), sourceContext = path.join(workDirectory, "source"), dependencyContext = path.join(workDirectory, "dependencies"), output = path.join(workDirectory, "output");
      mkdirSync(sourceContext); mkdirSync(dependencyContext); mkdirSync(output); writeFileSync(path.join(sourceContext, "source.tar"), readFileSync(source.path)); writeFileSync(path.join(dependencyContext, "dependencies.tar"), readFileSync(dependencies.path));
      execFileSync("docker", ["build", "--network=none", "--platform", `linux/${goarchForHost()}`, "--build-context", `source_bundle=${sourceContext}`, "--build-context", `dependency_bundle=${dependencyContext}`, "--output", `type=local,dest=${output}`, "--build-arg", `SOURCE_ARCHIVE_SHA256=${source.archive_sha256}`, "--build-arg", `DEPENDENCY_ARCHIVE_SHA256=${dependencies.archive_sha256}`, "-f", path.join(repoRoot, "runtime-images", "moltnet", "SourceBundle.Dockerfile"), repoRoot], { stdio: "inherit" });
      writeFileSync(binaryPath, readFileSync(path.join(output, "moltnet")), { mode: 0o755 }); assertDockerBinaryCapabilities(binaryPath);
    } else execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", binaryPath, "./cmd/moltnet"], {
      cwd: moltnetDir,
      env: { ...process.env, CGO_ENABLED: "0", GOARCH: arch, GOOS: "linux", GOTOOLCHAIN: "local" },
      stdio: "inherit"
    });
    if (!archiveMode) assertBuiltBinaryCapabilities(binaryPath);
    mkdirSync(releaseDir, { recursive: true });
    execFileSync("tar", ["-C", workDirectory, "-czf", assetPath, "moltnet"], { stdio: "inherit" });
  } finally {
    rmSync(workDirectory, { force: true, recursive: true });
  }
  const stamp = {
    arch, asset, capabilities: ["daimon-bridge", "pi-bridge"],
    development: { mode: "local-development", non_production: true, unsigned: true, unpublished: true },
    sha256: sha256(readFileSync(assetPath)),
    source_sha256: archiveMode ? validateSourceBundle(readFileSync(process.env.SPAWNFILE_MOLTNET_SOURCE_BUNDLE)).archive_sha256 : hashTrackedSourceEntries(moltnetDir, readTrackedEntries(moltnetDir)),
    ...(archiveMode ? { source_inputs: { dependencies_sha256: validateSourceBundle(readFileSync(process.env.SPAWNFILE_MOLTNET_GO_DEPENDENCY_BUNDLE)).archive_sha256, mode: "source-bundle", source_sha256: validateSourceBundle(readFileSync(process.env.SPAWNFILE_MOLTNET_SOURCE_BUNDLE)).archive_sha256, toolchain: "golang:1.24-bookworm@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac" } } : {}),
    stamp_version: "spawnfile.local-moltnet-release-stamp.v1"
  };
  writeFileSync(path.join(releaseDir, `local_moltnet_release_stamp_${arch}.json`), `${JSON.stringify(stamp)}\n`);
  process.stdout.write(`Staged local-development ${asset} (${stamp.source_sha256})\n`);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
