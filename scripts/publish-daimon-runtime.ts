#!/usr/bin/env node
// Builds the published, multi-architecture Daimon runtime image from the pinned
// Daimon commit in runtime-images/daimon/publish-inputs.json. CI runs it from
// .github/workflows/runtime-images.yml; without --push it is a dry-run build.
// Spawnfile never reads or carries engine credential contents.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { hashTrackedSourceEntries } from "./build-local-moltnet.ts";
import { assertClean, assertPinnedGrokCli, readPinnedGrokCli, trackedEntries } from "./build-local-daimon-runtime.ts";
import {
  createPublishedDaimonCapabilityReceipt,
  createPublishedIdentity,
  parseDaimonPublishInputs,
  renderRuntimesYamlPin,
  resolvePublishedRepository,
  resolvePublishedTag
} from "./daimon-publish-inputs.ts";
import type { DaimonPublishArchitecture, DaimonPublishInputs, PublishedPlatform } from "./daimon-publish-inputs.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inputsPath = path.join(repoRoot, "runtime-images", "daimon", "publish-inputs.json");
const vendoredManifestDigestPath = path.join(repoRoot, "src", "runtime", "daimon", "contract-manifest.sha256");
const sha256 = (value: Buffer | string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const run = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string =>
  execFileSync(command, args, { cwd: options.cwd, encoding: "utf8", env: options.env ?? process.env, stdio: ["ignore", "pipe", "inherit"] });

/** Build arguments the runtime Dockerfile verifies; mirrors the local builder's registry mode. */
export const createDaimonImageBuildArgs = (
  receipt: ReturnType<typeof createPublishedDaimonCapabilityReceipt>,
  receiptBytes: Buffer,
  codexVersion: string
): string[] => Object.entries({
  AGY_CLI_SHA256: receipt.engines.agy.executable_sha256.slice("sha256:".length),
  AGY_CLI_SHA512: receipt.provenance.agy.archive.sha512.slice("sha512:".length),
  AGY_CLI_URL: receipt.provenance.agy.archive.url,
  AGY_CLI_VERSION: receipt.provenance.agy.archive.version,
  CODEX_CLI_SHA256: receipt.engines.codex.executable_sha256,
  CODEX_CLI_VERSION: codexVersion,
  DAIMON_CAPABILITY_RECEIPT_BASE64: receiptBytes.toString("base64"),
  DAIMON_DEPENDENCY_ARCHIVE_SHA256: "none",
  DAIMON_DEPENDENCY_MODE: "registry",
  DAIMON_MANIFEST_SHA256: receipt.manifest_sha256,
  DAIMON_PACKAGE_SHA256: receipt.daimon.package_sha256,
  DAIMON_SOURCE_SHA256: receipt.daimon.source_sha256,
  GROK_CLI_SHA256: receipt.engines.grok.executable_sha256.slice("sha256:".length),
  GROK_CLI_URL: receipt.provenance.grok.executable.url,
  GROK_CLI_VERSION: receipt.provenance.grok.executable.version
}).flatMap(([name, value]) => ["--build-arg", `${name}=${value}`]);

const prepareDaimonCheckout = (inputs: DaimonPublishInputs, workDirectory: string): string => {
  const configured = process.env.SPAWNFILE_DAIMON_SOURCE_DIR?.trim();
  let checkout = configured ? path.resolve(configured) : path.join(workDirectory, "daimon");
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error("SPAWNFILE_DAIMON_SOURCE_DIR must be absolute");
  } else {
    run("git", ["clone", "--quiet", "--filter=blob:none", "--no-checkout", inputs.daimon.source, checkout]);
    run("git", ["-C", checkout, "checkout", "--quiet", "--detach", inputs.daimon.commit]);
  }
  checkout = path.resolve(checkout);
  const head = run("git", ["-C", checkout, "rev-parse", "HEAD"]).trim();
  if (head !== inputs.daimon.commit) throw new Error(`Daimon checkout is at ${head}, not the pinned ${inputs.daimon.commit}`);
  assertClean(checkout);
  const version = (JSON.parse(readFileSync(path.join(checkout, "package.json"), "utf8")) as { version?: unknown }).version;
  if (version !== inputs.daimon.package_version) throw new Error(`Daimon package version ${String(version)} is not the pinned ${inputs.daimon.package_version}`);
  return checkout;
};

const packDaimon = (checkout: string, architecture: DaimonPublishArchitecture, stage: string): string => {
  mkdirSync(stage, { recursive: true });
  const before = new Set(readdirSync(stage));
  run("npm", ["pack", "--silent", "--pack-destination", stage], {
    cwd: checkout,
    env: { ...process.env, DAIMON_ENGINE_BROKER_ARCH: architecture === "amd64" ? "x64" : "arm64", DAIMON_REQUIRE_ENGINE_BROKER: "1" }
  });
  const created = readdirSync(stage).filter((name) => name.endsWith(".tgz") && !before.has(name));
  if (created.length !== 1 || !created[0]) throw new Error("npm pack did not produce exactly one Daimon tarball");
  const packed = path.join(stage, "daimon.tgz");
  execFileSync("mv", [path.join(stage, created[0]), packed]);
  // Registry dependency mode: the Dockerfile still copies these inputs, so stage the same markers the local builder does.
  writeFileSync(path.join(stage, "dependencies.tar"), "clean-git-network-mode\n", { mode: 0o600 });
  writeFileSync(path.join(stage, "source-inputs.json"), '{"mode":"clean-git"}\n', { mode: 0o600 });
  writeFileSync(path.join(stage, "agy.tar.gz"), "registry-mode\n", { mode: 0o600 });
  writeFileSync(path.join(stage, "grok"), "registry-mode\n", { mode: 0o600 });
  return packed;
};

const buildPlatform = (options: {
  architecture: DaimonPublishArchitecture; checkout: string; inputs: DaimonPublishInputs; manifestSha256: string;
  push: boolean; repository: string; sourceSha256: string; workDirectory: string;
}): PublishedPlatform => {
  const { architecture, inputs } = options;
  const stage = path.join(options.workDirectory, `package-${architecture}`);
  const packagePath = packDaimon(options.checkout, architecture, stage);
  const manifestSha256 = sha256(execFileSync("tar", ["-xOf", packagePath, "package/dist/runtime/contract-manifest.json"]));
  if (manifestSha256 !== options.manifestSha256) {
    throw new Error(`Daimon ${architecture} package manifest ${manifestSha256} is not the vendored contract ${options.manifestSha256}`);
  }
  const grok = readPinnedGrokCli(architecture);
  const agy = inputs.agy.platforms[architecture];
  if (!agy) throw new Error(`Missing AGY pin for ${architecture}`);
  const artifacts = {
    agy: { archive_sha512: agy.archive_sha512, executable_sha256: agy.executable_sha256, url: agy.url, version: inputs.agy.version },
    codex: { executable_sha256: inputs.codex.executable_sha256 },
    grok: { executable_sha256: grok.sha256, url: grok.url, version: grok.version }
  };
  assertPinnedGrokCli(artifacts.grok, grok);
  const packageSha256 = sha256(readFileSync(packagePath));
  const receipt = createPublishedDaimonCapabilityReceipt({
    architecture, artifacts, manifestSha256, packageSha256, sourceSha256: options.sourceSha256
  }, inputs.daimon);
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
  const metadataFile = path.join(options.workDirectory, `metadata-${architecture}.json`);
  const output = options.push
    ? `type=image,name=${options.repository},push-by-digest=true,name-canonical=true,push=true`
    : "type=cacheonly";
  execFileSync("docker", [
    "buildx", "build", "--platform", `linux/${architecture}`, "--provenance=false", "--sbom=false",
    "--build-context", `daimon_package=${stage}`, "-f", path.join(repoRoot, "runtime-images", "daimon", "Dockerfile"),
    ...createDaimonImageBuildArgs(receipt, receiptBytes, inputs.codex.version),
    "--metadata-file", metadataFile, "--output", output, repoRoot
  ], { stdio: "inherit" });
  const metadata = existsSync(metadataFile) ? JSON.parse(readFileSync(metadataFile, "utf8")) as Record<string, unknown> : {};
  const digest = metadata["containerimage.digest"];
  if (options.push && (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(digest))) {
    throw new Error(`Docker did not report an immutable ${architecture} manifest digest`);
  }
  return {
    capability_receipt_sha256: sha256(receiptBytes),
    image_manifest_digest: typeof digest === "string" ? digest : "unpublished",
    package_sha256: packageSha256
  };
};

const tagExists = (reference: string): boolean => {
  try {
    execFileSync("docker", ["buildx", "imagetools", "inspect", reference], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** Creates the multi-arch index and proves it lists exactly the per-arch digests just pushed. */
const publishIndex = (repository: string, tags: string[], platforms: Partial<Record<DaimonPublishArchitecture, PublishedPlatform>>): string => {
  const sources = Object.values(platforms).map((platform) => `${repository}@${platform.image_manifest_digest}`);
  execFileSync("docker", ["buildx", "imagetools", "create", ...tags.flatMap((tag) => ["-t", `${repository}:${tag}`]), ...sources], { stdio: "inherit" });
  const raw = execFileSync("docker", ["buildx", "imagetools", "inspect", "--raw", `${repository}:${tags[0]}`]);
  const index = JSON.parse(raw.toString("utf8")) as { manifests?: Array<{ digest?: string; platform?: { architecture?: string; os?: string } }> };
  for (const [architecture, platform] of Object.entries(platforms)) {
    const entry = index.manifests?.find((manifest) => manifest.platform?.os === "linux" && manifest.platform.architecture === architecture);
    if (entry?.digest !== platform.image_manifest_digest) throw new Error(`Published index does not bind ${architecture} to ${platform.image_manifest_digest}`);
  }
  return sha256(raw);
};

const main = (): void => {
  const { values } = parseArgs({ options: {
    force: { type: "boolean", default: false },
    "identity-out": { type: "string" },
    latest: { type: "boolean", default: false },
    platform: { type: "string", multiple: true },
    push: { type: "boolean", default: false },
    repository: { type: "string" }
  } });
  const inputs = parseDaimonPublishInputs(JSON.parse(readFileSync(inputsPath, "utf8")));
  if (values.platform?.length) {
    const selected = values.platform as DaimonPublishArchitecture[];
    if (values.push) throw new Error("--platform narrows dry-run builds only; a published index carries every pinned platform");
    if (selected.some((entry) => !inputs.platforms.includes(entry))) throw new Error(`--platform must be one of ${inputs.platforms.join(", ")}`);
    inputs.platforms = selected;
  }
  const repository = resolvePublishedRepository(inputs, values.repository);
  const tag = resolvePublishedTag(inputs);
  if (values.push && !values.force && tagExists(`${repository}:${tag}`)) {
    process.stdout.write(`${repository}:${tag} already exists; refusing to move a published tag (pass --force to republish)\n`);
    return;
  }
  const manifestSha256 = readFileSync(vendoredManifestDigestPath, "utf8").trim();
  const workDirectory = mkdtempSync(path.join(os.tmpdir(), "spawnfile-daimon-publish-"));
  try {
    const checkout = prepareDaimonCheckout(inputs, workDirectory);
    const sourceSha256 = hashTrackedSourceEntries(checkout, trackedEntries(checkout));
    run("npm", ["ci", "--no-audit", "--no-fund", "--silent"], { cwd: checkout });
    const platforms: Partial<Record<DaimonPublishArchitecture, PublishedPlatform>> = {};
    for (const architecture of inputs.platforms) {
      const platform = buildPlatform({
        architecture, checkout, inputs, manifestSha256, push: values.push, repository, sourceSha256, workDirectory
      });
      platforms[architecture] = platform;
      process.stdout.write(`Daimon ${architecture}: receipt ${platform.capability_receipt_sha256}, manifest ${platform.image_manifest_digest}\n`);
    }
    if (!values.push) {
      process.stdout.write(`Dry-run built ${inputs.platforms.join(", ")} for ${repository}:${tag}; nothing was pushed\n`);
      return;
    }
    const digest = publishIndex(repository, values.latest ? [tag, "latest"] : [tag], platforms);
    const identity = createPublishedIdentity(inputs, { contractManifestSha256: manifestSha256, digest, platforms, repository, tag });
    const serialized = `${JSON.stringify(identity, null, 2)}\n`;
    if (values["identity-out"]) writeFileSync(path.resolve(values["identity-out"]), serialized);
    process.stdout.write(`Published ${repository}:${tag} as ${identity.image_reference}\n${serialized}runtimes.yaml pin:\n${renderRuntimesYamlPin(identity)}\n`);
  } finally {
    rmSync(workDirectory, { force: true, recursive: true });
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
