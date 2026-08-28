#!/usr/bin/env node
// Builds a generic local Daimon image from a clean, packaged sibling source.
// Spawnfile never reads or carries engine credential contents.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hashTrackedSourceEntries } from "./build-local-moltnet.mjs";
import { validateSourceBundle } from "./source-provenance-bundle.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configuredDaimonSource = process.env.SPAWNFILE_DAIMON_SOURCE_DIR?.trim();
const daimonDir = configuredDaimonSource
  ? path.resolve(configuredDaimonSource)
  : path.resolve(repoRoot, "..", "daimon");
const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const LOCAL_REPOSITORY_PATH = "noopolis/spawnfile-runtime-daimon";
const sha256Digest = /^[a-f0-9]{64}$/u;
const sha512Digest = /^[a-f0-9]{128}$/u;
const version = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/u;
const LOCAL_DEVELOPMENT_PROVENANCE = Object.freeze({
  mode: "local-development",
  non_production: true,
  unsigned: true,
  unpublished: true
});

const requiredDigest = (env, name, algorithm, pattern) => {
  const value = env[name]?.trim();
  const bare = value?.replace(new RegExp(`^${algorithm}:`, "u"), "");
  if (!bare || !pattern.test(bare)) throw new Error(`${name} must be a ${algorithm.toUpperCase()} digest`);
  return `${algorithm}:${bare}`;
};

const requiredUrl = (env, name) => {
  const value = env[name]?.trim();
  let parsed;
  try {
    parsed = value ? new URL(value) : null;
  } catch {
    parsed = null;
  }
  if (
    !parsed || parsed.protocol !== "https:" || parsed.username || parsed.password ||
    parsed.search || parsed.hash
  ) {
    throw new Error(`${name} must be a credential-free HTTPS URL without query or fragment`);
  }
  return value;
};

const requiredVersion = (env, name) => {
  const value = env[name]?.trim();
  if (!value || !version.test(value)) throw new Error(`${name} must be an explicit artifact version`);
  return value;
};

export const readDaimonCliArtifactPins = (env = process.env) => ({
  agy: {
    archive_sha512: requiredDigest(env, "AGY_CLI_SHA512", "sha512", sha512Digest),
    executable_sha256: requiredDigest(env, "AGY_CLI_SHA256", "sha256", sha256Digest),
    url: requiredUrl(env, "AGY_CLI_URL"),
    version: requiredVersion(env, "AGY_CLI_VERSION")
  },
  codex: {
    executable_sha256: requiredDigest(env, "CODEX_CLI_SHA256", "sha256", sha256Digest)
  },
  grok: {
    executable_sha256: requiredDigest(env, "GROK_CLI_SHA256", "sha256", sha256Digest),
    url: requiredUrl(env, "GROK_CLI_URL"),
    version: requiredVersion(env, "GROK_CLI_VERSION")
  }
});

export const resolveLocalImageTag = (value) => {
  const tag = value?.trim();
  const match = tag?.match(/^127\.0\.0\.1:((?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5]))\/noopolis\/spawnfile-runtime-daimon:([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/u);
  const port = Number(match?.[1]); const label = match?.[2] ?? "";
  const repository = match ? `127.0.0.1:${port}/${LOCAL_REPOSITORY_PATH}` : "";
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("SPAWNFILE_DAIMON_LOCAL_IMAGE_TAG must use an explicit 127.0.0.1 loopback registry port");
  if (!label || label === "latest" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u.test(label)) {
    throw new Error(`SPAWNFILE_DAIMON_LOCAL_IMAGE_TAG must be an explicit non-latest tag under ${repository}`);
  }
  return tag;
};

export const resolveLocalBuildArchitecture = (hostArchitecture) => {
  if (hostArchitecture !== "x64" && hostArchitecture !== "arm64") {
    throw new Error("Local Daimon builds require an x64 or arm64 Docker host for the linux/amd64 artifact");
  }
  return "amd64";
};

export const resolvePushedImageReference = (imageTag, repoDigests) => {
  const repository = imageTag.slice(0, imageTag.lastIndexOf(":"));
  resolveLocalImageTag(imageTag);
  const expectedPrefix = `${repository}@`;
  const matches = repoDigests.filter((value) => value.startsWith(expectedPrefix));
  if (matches.length !== 1 || !new RegExp(`^${expectedPrefix.replaceAll(".", "\\.")}sha256:[a-f0-9]{64}$`, "u").test(matches[0])) {
    throw new Error("Docker did not return one immutable local Daimon image manifest digest");
  }
  if (imageTag.slice(0, imageTag.lastIndexOf(":")) !== repository) {
    throw new Error("Local Daimon image tag and pushed repository disagree");
  }
  return matches[0];
};

const trackedEntries = (root) => execFileSync("git", ["-C", root, "ls-files", "-s", "-z"], { encoding: "utf8" })
  .split("\0").filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t");
    const [mode] = entry.slice(0, tab).split(" ");
    return { mode, path: entry.slice(tab + 1) };
  });

const assertClean = (root) => {
  const status = execFileSync("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" });
  if (status.trim()) throw new Error("Local Daimon image build requires a clean source tree");
};

const stagePackagedDaimon = (directory) => {
  const source = process.env.SPAWNFILE_DAIMON_PACKAGE_TARBALL?.trim();
  if (!source || !path.isAbsolute(source)) throw new Error("SPAWNFILE_DAIMON_PACKAGE_TARBALL must be an absolute packaged Daimon tarball");
  const entry = lstatSync(source);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size === 0) throw new Error("SPAWNFILE_DAIMON_PACKAGE_TARBALL must be a nonempty regular file");
  const staged = path.join(directory, "daimon.tgz");
  copyFileSync(source, staged);
  writeFileSync(path.join(directory, "dependencies.tar"), "clean-git-network-mode\n", { mode: 0o600 });
  writeFileSync(path.join(directory, "source-inputs.json"), '{"mode":"clean-git"}\n', { mode: 0o600 });
  writeFileSync(path.join(directory, "agy.tar.gz"), "registry-mode\n", { mode: 0o600 }); writeFileSync(path.join(directory, "grok"), "registry-mode\n", { mode: 0o600 });
  return staged;
};

const requiredBundle = (envName, stagedName, directory, expectedProfile) => {
  const source = process.env[envName]?.trim();
  if (!source || !path.isAbsolute(source)) throw new Error(`${envName} must be an absolute deterministic source-provenance tar`);
  const entry = lstatSync(source); if (!entry.isFile() || entry.isSymbolicLink() || entry.size === 0) throw new Error(`${envName} must be a nonempty regular file`);
  const bytes = readFileSync(source), provenance = validateSourceBundle(bytes), staged = path.join(directory, stagedName);
  if (provenance.manifest.exclude_policy.profile !== expectedProfile) throw new Error(`${envName} has the wrong provenance profile`);
  copyFileSync(source, staged); return { ...provenance, path: staged };
};

export const resolveDaimonSourceMode = (env = process.env) => {
  const source = env.SPAWNFILE_DAIMON_SOURCE_BUNDLE?.trim(), dependencies = env.SPAWNFILE_DAIMON_DEPENDENCY_BUNDLE?.trim();
  if (!source && !dependencies) return "clean-git";
  if (!source || !dependencies) throw new Error("Archive provenance requires both SPAWNFILE_DAIMON_SOURCE_BUNDLE and SPAWNFILE_DAIMON_DEPENDENCY_BUNDLE");
  return "source-bundle";
};

const stageOfflineCliAssets = (directory, artifacts) => {
  for (const [envName, destination, expected, algorithm] of [["SPAWNFILE_AGY_CLI_ARCHIVE", "agy.tar.gz", artifacts.agy.archive_sha512, "sha512"], ["SPAWNFILE_GROK_CLI_FILE", "grok", artifacts.grok.executable_sha256, "sha256"]]) {
    const source = process.env[envName]?.trim(); if (!source || !path.isAbsolute(source)) throw new Error(`${envName} must be an absolute pinned offline CLI asset`);
    const item = lstatSync(source); if (!item.isFile() || item.isSymbolicLink() || item.size === 0) throw new Error(`${envName} must be a nonempty regular file`);
    const actual = `${algorithm}:${createHash(algorithm).update(readFileSync(source)).digest("hex")}`; if (actual !== expected) throw new Error(`${envName} checksum disagrees with its artifact pin`);
    copyFileSync(source, path.join(directory, destination));
  }
};

const stageBundleBuiltDaimon = (directory, artifacts) => {
  const sourceDirectory = path.join(directory, "source_bundle"), dependencyDirectory = path.join(directory, "dependency_bundle");
  mkdirSync(sourceDirectory, { recursive: true }); mkdirSync(dependencyDirectory, { recursive: true });
  const source = requiredBundle("SPAWNFILE_DAIMON_SOURCE_BUNDLE", "source.tar", sourceDirectory, "source");
  const dependencies = requiredBundle("SPAWNFILE_DAIMON_DEPENDENCY_BUNDLE", "dependencies.tar", dependencyDirectory, "dependencies");
  const output = path.join(directory, "package"); mkdirSync(output, { recursive: true });
  execFileSync("docker", ["build", "--network=none", "--platform", "linux/amd64", "--build-context", `source_bundle=${sourceDirectory}`,
    "--build-context", `dependency_bundle=${dependencyDirectory}`, "--output", `type=local,dest=${output}`,
    "--build-arg", `SOURCE_ARCHIVE_SHA256=${source.archive_sha256}`, "--build-arg", `DEPENDENCY_ARCHIVE_SHA256=${dependencies.archive_sha256}`,
    "--build-arg", `SOURCE_MANIFEST_SHA256=${source.manifest_sha256}`, "--build-arg", `DEPENDENCY_MANIFEST_SHA256=${dependencies.manifest_sha256}`,
    "-f", path.join(repoRoot, "runtime-images", "daimon", "SourceBundle.Dockerfile"), repoRoot], { stdio: "inherit" });
  const builtPackagePath = path.join(output, "daimon.tgz"), packagePath = path.join(directory, "daimon.tgz");
  if (!existsSync(builtPackagePath)) throw new Error("Remote bundle build did not produce daimon.tgz");
  copyFileSync(builtPackagePath, packagePath);
  const runtimeDependencies = path.join(output, "runtime-dependencies.tar");
  if (!existsSync(runtimeDependencies)) throw new Error("Remote bundle build did not produce its runtime dependency closure");
  const runtimeArchiveSha256 = sha256(readFileSync(runtimeDependencies)); copyFileSync(runtimeDependencies, path.join(directory, "dependencies.tar"));
  const sourceInputs = { dependencies: { archive_sha256: dependencies.archive_sha256, manifest_sha256: dependencies.manifest_sha256,
      package_lock_sha256: dependencies.manifest.dependency_lock.package_lock_sha256, runtime_archive_sha256: runtimeArchiveSha256 },
    mode: "source-bundle", source: { archive_sha256: source.archive_sha256, manifest_sha256: source.manifest_sha256 },
    version: "spawnfile.daimon-source-inputs.v1" };
  const buildIdentity = JSON.parse(readFileSync(path.join(output, "source-inputs.json"), "utf8"));
  if (buildIdentity.target !== "linux/amd64" || buildIdentity.source.archive_sha256 !== source.archive_sha256 || buildIdentity.source.manifest_sha256 !== source.manifest_sha256 ||
    buildIdentity.dependencies.archive_sha256 !== dependencies.archive_sha256 || buildIdentity.dependencies.manifest_sha256 !== dependencies.manifest_sha256) {
    throw new Error("Remote bundle build source identity does not match its attested inputs");
  }
  writeFileSync(path.join(directory, "source-inputs.json"), `${JSON.stringify(sourceInputs)}\n`, { mode: 0o600 });
  stageOfflineCliAssets(directory, artifacts);
  return { packagePath, sourceInputs, sourceSha256: sha256(Buffer.from(JSON.stringify(sourceInputs))) };
};

export const createLocalDaimonCapabilityReceipt = ({ architecture, artifacts, manifestSha256, packageSha256, sourceInputs, sourceSha256 }) => ({
  architecture,
  daimon: { package_sha256: packageSha256, source_sha256: sourceSha256, ...(sourceInputs ? { source_inputs: sourceInputs } : {}) },
  engines: {
    agy: { executable_sha256: artifacts.agy.executable_sha256 },
    codex: { executable_sha256: artifacts.codex.executable_sha256 },
    grok: { executable_sha256: artifacts.grok.executable_sha256 }
  },
  manifest_sha256: manifestSha256,
  provenance: {
    agy: {
      archive: {
        format: "tar.gz",
        sha512: artifacts.agy.archive_sha512,
        url: artifacts.agy.url,
        version: artifacts.agy.version
      }
    },
    grok: {
      executable: {
        sha256: artifacts.grok.executable_sha256,
        url: artifacts.grok.url,
        version: artifacts.grok.version
      }
    },
    ...LOCAL_DEVELOPMENT_PROVENANCE
  },
  version: "spawnfile.daimon-runtime-capability-receipt.v1"
});

const main = () => {
  if (configuredDaimonSource && !path.isAbsolute(configuredDaimonSource)) {
    throw new Error("SPAWNFILE_DAIMON_SOURCE_DIR must be absolute");
  }
  const sourceMode = resolveDaimonSourceMode();
  if (sourceMode === "clean-git") {
    if (!existsSync(path.join(daimonDir, ".git"))) throw new Error(`Missing sibling Daimon checkout: ${daimonDir}`);
    assertClean(daimonDir);
  }
  const imageTag = resolveLocalImageTag(process.env.SPAWNFILE_DAIMON_LOCAL_IMAGE_TAG);
  const architecture = resolveLocalBuildArchitecture(process.arch);
  const artifacts = readDaimonCliArtifactPins();
  const packageDirectory = mkdtempSync(path.join(os.tmpdir(), "spawnfile-daimon-package-"));
  try {
    const bundled = sourceMode === "source-bundle" ? stageBundleBuiltDaimon(packageDirectory, artifacts) : null;
    const packagePath = bundled?.packagePath ?? stagePackagedDaimon(packageDirectory);
    const manifestBytes = execFileSync("tar", ["-xOf", packagePath, "package/dist/runtime/contract-manifest.json"]);
    const receipt = createLocalDaimonCapabilityReceipt({
      architecture,
      artifacts,
      manifestSha256: sha256(manifestBytes),
      packageSha256: sha256(readFileSync(packagePath)),
      sourceInputs: bundled?.sourceInputs,
      sourceSha256: bundled?.sourceSha256 ?? hashTrackedSourceEntries(daimonDir, trackedEntries(daimonDir))
    });
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
    execFileSync("docker", ["build", ...(bundled ? ["--network=none"] : []), "--platform", `linux/${architecture}`, "--build-context", `daimon_package=${packageDirectory}`,
      "-f", path.join(repoRoot, "runtime-images", "daimon", "Dockerfile"), "-t", imageTag,
      "--build-arg", `DAIMON_CAPABILITY_RECEIPT_BASE64=${receiptBytes.toString("base64")}`,
      "--build-arg", `DAIMON_MANIFEST_SHA256=${receipt.manifest_sha256}`,
      "--build-arg", `DAIMON_PACKAGE_SHA256=${receipt.daimon.package_sha256}`,
      "--build-arg", `DAIMON_SOURCE_SHA256=${receipt.daimon.source_sha256}`,
      "--build-arg", `DAIMON_DEPENDENCY_MODE=${bundled ? "offline-bundle" : "registry"}`,
      "--build-arg", `DAIMON_DEPENDENCY_ARCHIVE_SHA256=${bundled?.sourceInputs.dependencies.runtime_archive_sha256 ?? "none"}`,
      "--build-arg", `CODEX_CLI_SHA256=${artifacts.codex.executable_sha256}`,
      "--build-arg", `GROK_CLI_VERSION=${artifacts.grok.version}`,
      "--build-arg", `GROK_CLI_URL=${artifacts.grok.url}`,
      "--build-arg", `GROK_CLI_SHA256=${receipt.engines.grok.executable_sha256.slice("sha256:".length)}`,
      "--build-arg", `AGY_CLI_VERSION=${artifacts.agy.version}`,
      "--build-arg", `AGY_CLI_URL=${artifacts.agy.url}`,
      "--build-arg", `AGY_CLI_SHA512=${artifacts.agy.archive_sha512.slice("sha512:".length)}`,
      "--build-arg", `AGY_CLI_SHA256=${receipt.engines.agy.executable_sha256.slice("sha256:".length)}`,
      repoRoot
    ], { stdio: "inherit" });
    execFileSync("docker", ["push", imageTag], { stdio: "inherit" });
    const [imageConfigDigest, imageArchitecture, repoDigestsJson] = execFileSync(
      "docker", ["image", "inspect", "--format", "{{.Id}}\n{{.Architecture}}\n{{json .RepoDigests}}", imageTag], { encoding: "utf8" }
    ).trim().split("\n");
    if (!/^sha256:[a-f0-9]{64}$/u.test(imageConfigDigest)) throw new Error("Docker did not return an immutable image config digest");
    if (imageArchitecture !== architecture) throw new Error("Docker image architecture does not match the selected local Daimon inputs");
    const imageReference = resolvePushedImageReference(imageTag, JSON.parse(repoDigestsJson));
    const imageManifestDigest = imageReference.slice(imageReference.indexOf("@") + 1);
    const registryAuthority = imageTag.slice(0, imageTag.indexOf("/"));
    writeFileSync(path.join(repoRoot, ".local-daimon-runtime-identity.json"), `${JSON.stringify({
      capability_receipt_sha256: sha256(receiptBytes), development: LOCAL_DEVELOPMENT_PROVENANCE,
      image_architecture: imageArchitecture, image_config_digest: imageConfigDigest,
      image_manifest_digest: imageManifestDigest, image_reference: imageReference,
      manifest_sha256: receipt.manifest_sha256,
      registry_authority: registryAuthority,
      version: "spawnfile.local-daimon-runtime-identity.v3"
    })}\n`);
    process.stdout.write(`Built local-development Daimon image ${imageReference} (${imageConfigDigest})\n`);
  } finally {
    rmSync(packageDirectory, { force: true, recursive: true });
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
