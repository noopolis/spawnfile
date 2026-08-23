#!/usr/bin/env node
// Builds a generic local Daimon image from a clean, packaged sibling source.
// Spawnfile never reads or carries engine credential contents.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hashTrackedSourceEntries } from "./build-local-moltnet.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configuredDaimonSource = process.env.SPAWNFILE_DAIMON_SOURCE_DIR?.trim();
const daimonDir = configuredDaimonSource
  ? path.resolve(configuredDaimonSource)
  : path.resolve(repoRoot, "..", "daimon");
const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const digest = /^[a-f0-9]{64}$/u;

const requiredDigest = (name) => {
  const value = process.env[name]?.trim();
  if (!value || !digest.test(value.replace(/^sha256:/u, ""))) throw new Error(`${name} must be a SHA-256 digest`);
  return `sha256:${value.replace(/^sha256:/u, "")}`;
};

const requiredUrl = (name) => {
  const value = process.env[name]?.trim();
  if (!value || !/^https:\/\//u.test(value)) throw new Error(`${name} must be an HTTPS URL`);
  return value;
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
  return staged;
};

export const createLocalDaimonCapabilityReceipt = ({ architecture, manifestSha256, packageSha256, sourceSha256 }) => ({
  architecture,
  daimon: { package_sha256: packageSha256, source_sha256: sourceSha256 },
  engines: {
    agy: { executable_sha256: requiredDigest("AGY_CLI_SHA256") },
    codex: { executable_sha256: requiredDigest("CODEX_CLI_SHA256") },
    grok: { executable_sha256: requiredDigest("GROK_CLI_SHA256") }
  },
  manifest_sha256: manifestSha256,
  provenance: { mode: "local-development", non_production: true, unsigned: true, unpublished: true },
  version: "spawnfile.daimon-runtime-capability-receipt.v1"
});

const main = () => {
  if (configuredDaimonSource && !path.isAbsolute(configuredDaimonSource)) {
    throw new Error("SPAWNFILE_DAIMON_SOURCE_DIR must be absolute");
  }
  if (!existsSync(path.join(daimonDir, ".git"))) throw new Error(`Missing sibling Daimon checkout: ${daimonDir}`);
  assertClean(daimonDir);
  const manifestPath = path.join(daimonDir, "dist", "runtime", "contract-manifest.json");
  if (!existsSync(manifestPath)) throw new Error("Local Daimon package must contain dist/runtime/contract-manifest.json");
  const imageTag = process.env.SPAWNFILE_DAIMON_LOCAL_IMAGE_TAG?.trim();
  if (!imageTag || imageTag.includes("@") || imageTag.endsWith(":latest")) {
    throw new Error("SPAWNFILE_DAIMON_LOCAL_IMAGE_TAG must be an explicit non-latest local tag");
  }
  const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null;
  if (!architecture) throw new Error(`Unsupported local Daimon architecture: ${process.arch}`);
  const packageDirectory = mkdtempSync(path.join(os.tmpdir(), "spawnfile-daimon-package-"));
  try {
    const packagePath = stagePackagedDaimon(packageDirectory);
    const receipt = createLocalDaimonCapabilityReceipt({
      architecture,
      manifestSha256: sha256(readFileSync(manifestPath)),
      packageSha256: sha256(readFileSync(packagePath)),
      sourceSha256: hashTrackedSourceEntries(daimonDir, trackedEntries(daimonDir))
    });
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
    execFileSync("docker", ["build", "--platform", `linux/${architecture}`, "--build-context", `daimon_package=${packageDirectory}`,
      "-f", path.join(repoRoot, "runtime-images", "daimon", "Dockerfile"), "-t", imageTag,
      "--build-arg", `DAIMON_CAPABILITY_RECEIPT_BASE64=${receiptBytes.toString("base64")}`,
      "--build-arg", `DAIMON_MANIFEST_SHA256=${receipt.manifest_sha256}`,
      "--build-arg", `DAIMON_PACKAGE_SHA256=${receipt.daimon.package_sha256}`,
      "--build-arg", `DAIMON_SOURCE_SHA256=${receipt.daimon.source_sha256}`,
      "--build-arg", `CODEX_CLI_SHA256=${receipt.engines.codex.executable_sha256}`,
      "--build-arg", `GROK_CLI_URL=${requiredUrl("GROK_CLI_URL")}`,
      "--build-arg", `GROK_CLI_SHA256=${receipt.engines.grok.executable_sha256.slice("sha256:".length)}`,
      "--build-arg", `AGY_CLI_URL=${requiredUrl("AGY_CLI_URL")}`,
      "--build-arg", `AGY_CLI_SHA256=${receipt.engines.agy.executable_sha256.slice("sha256:".length)}`,
      repoRoot
    ], { stdio: "inherit" });
    const [imageConfigDigest, imageArchitecture] = execFileSync(
      "docker", ["image", "inspect", "--format", "{{.Id}}\n{{.Architecture}}", imageTag], { encoding: "utf8" }
    ).trim().split("\n");
    if (!/^sha256:[a-f0-9]{64}$/u.test(imageConfigDigest)) throw new Error("Docker did not return an immutable image config digest");
    if (imageArchitecture !== architecture) throw new Error("Docker image architecture does not match the selected local Daimon inputs");
    writeFileSync(path.join(repoRoot, ".local-daimon-runtime-identity.json"), `${JSON.stringify({
      capability_receipt_sha256: sha256(receiptBytes), development: receipt.provenance,
      image_architecture: imageArchitecture, image_config_digest: imageConfigDigest,
      image_reference: imageTag, manifest_sha256: receipt.manifest_sha256,
      version: "spawnfile.local-daimon-runtime-identity.v1"
    })}\n`);
    process.stdout.write(`Built local-development Daimon image ${imageTag} (${imageConfigDigest})\n`);
  } finally {
    rmSync(packageDirectory, { force: true, recursive: true });
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
