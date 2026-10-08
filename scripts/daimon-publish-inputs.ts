// Pure validation and identity shaping for the CI-published Daimon runtime image.
// Docker and git orchestration lives in publish-daimon-runtime.ts.

import { createLocalDaimonCapabilityReceipt } from "./build-local-daimon-runtime.ts";

export type DaimonPublishArchitecture = "amd64" | "arm64";

type AgyPlatformPin = {
  archive_sha512: string;
  executable_sha256: string;
  url: string;
};

export type DaimonPublishInputs = {
  agy: { platforms: Partial<Record<DaimonPublishArchitecture, AgyPlatformPin>>; version: string };
  codex: { executable_sha256: string; version: string };
  daimon: { commit: string; package_version: string; source: string };
  image: string;
  platforms: DaimonPublishArchitecture[];
  registry: string;
  version: "spawnfile.daimon-runtime-publish-inputs.v1";
};

export type PublishedPlatform = {
  capability_receipt_sha256: string;
  image_manifest_digest: string;
  package_sha256: string;
};

export type PublishedDaimonRuntimeIdentity = {
  capability_receipts: Partial<Record<DaimonPublishArchitecture, string>>;
  contract_manifest_sha256: string;
  daimon: DaimonPublishInputs["daimon"];
  digest: string;
  image: string;
  image_reference: string;
  platforms: Partial<Record<DaimonPublishArchitecture, PublishedPlatform>>;
  registry: string;
  tag: string;
  version: "spawnfile.published-daimon-runtime-identity.v1";
};

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const SHA512 = /^sha512:[a-f0-9]{128}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/u;
const IMAGE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u;
const REGISTRY = /^[a-z0-9.-]+(?::[0-9]{1,5})?$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: unknown, keys: string[], label: string): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  if (actual.join(",") !== [...keys].sort().join(",")) throw new Error(`${label} must have exactly: ${keys.join(", ")}`);
  return value;
};

const matching = (value: unknown, pattern: RegExp, label: string): string => {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is malformed`);
  return value;
};

const httpsUrl = (value: unknown, label: string): string => {
  let parsed: URL | null = null;
  try {
    parsed = typeof value === "string" ? new URL(value) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${label} must be a credential-free HTTPS URL without query or fragment`);
  }
  return value as string;
};

/** Validates the checked-in publish inputs; every pin is explicit, nothing floats. */
export const parseDaimonPublishInputs = (raw: unknown): DaimonPublishInputs => {
  const root = exactKeys(raw, ["agy", "codex", "daimon", "image", "platforms", "registry", "version"], "publish inputs");
  if (root.version !== "spawnfile.daimon-runtime-publish-inputs.v1") throw new Error("publish inputs version is unsupported");
  const platforms = root.platforms;
  if (!Array.isArray(platforms) || platforms.length === 0 || new Set(platforms).size !== platforms.length ||
    platforms.some((entry) => entry !== "amd64" && entry !== "arm64")) {
    throw new Error("publish inputs platforms must be a nonempty unique list of amd64/arm64");
  }
  const daimon = exactKeys(root.daimon, ["commit", "package_version", "source"], "daimon");
  const codex = exactKeys(root.codex, ["executable_sha256", "version"], "codex");
  const agy = exactKeys(root.agy, ["platforms", "version"], "agy");
  if (!isRecord(agy.platforms)) throw new Error("agy.platforms must be an object");
  const agyPlatforms: Partial<Record<DaimonPublishArchitecture, AgyPlatformPin>> = {};
  for (const architecture of platforms as DaimonPublishArchitecture[]) {
    const pin = exactKeys(agy.platforms[architecture], ["archive_sha512", "executable_sha256", "url"], `agy.platforms.${architecture}`);
    agyPlatforms[architecture] = {
      archive_sha512: matching(pin.archive_sha512, SHA512, `agy.platforms.${architecture}.archive_sha512`),
      executable_sha256: matching(pin.executable_sha256, SHA256, `agy.platforms.${architecture}.executable_sha256`),
      url: httpsUrl(pin.url, `agy.platforms.${architecture}.url`)
    };
  }
  return {
    agy: { platforms: agyPlatforms, version: matching(agy.version, VERSION, "agy.version") },
    codex: {
      executable_sha256: matching(codex.executable_sha256, SHA256, "codex.executable_sha256"),
      version: matching(codex.version, VERSION, "codex.version")
    },
    daimon: {
      commit: matching(daimon.commit, COMMIT, "daimon.commit"),
      package_version: matching(daimon.package_version, VERSION, "daimon.package_version"),
      source: httpsUrl(daimon.source, "daimon.source")
    },
    image: matching(root.image, IMAGE, "image"),
    platforms: platforms as DaimonPublishArchitecture[],
    registry: matching(root.registry, REGISTRY, "registry"),
    version: "spawnfile.daimon-runtime-publish-inputs.v1"
  };
};

/** One tag per pinned Daimon commit: `<package version>-<short commit>`, never `latest`. */
export const resolvePublishedTag = (inputs: DaimonPublishInputs): string =>
  `${inputs.daimon.package_version}-${inputs.daimon.commit.slice(0, 7)}`;

export const resolvePublishedRepository = (inputs: DaimonPublishInputs, override?: string): string => {
  const repository = override?.trim() || `${inputs.registry}/${inputs.image}`;
  if (!/^[a-z0-9.-]+(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u.test(repository)) {
    throw new Error("Daimon publish repository must be <registry>/<path> without tag or digest");
  }
  return repository;
};

type ReceiptOptions = Parameters<typeof createLocalDaimonCapabilityReceipt>[0];

/**
 * Same receipt shape the image Dockerfile verifies, but the provenance marks a
 * CI publication from a pinned Daimon commit instead of a local development build.
 */
export const createPublishedDaimonCapabilityReceipt = (options: ReceiptOptions, daimon: DaimonPublishInputs["daimon"]) => {
  const { provenance, ...rest } = createLocalDaimonCapabilityReceipt(options);
  return {
    ...rest,
    provenance: {
      agy: provenance.agy,
      grok: provenance.grok,
      mode: "ci-published" as const,
      source: { commit: daimon.commit, package_version: daimon.package_version, repository: daimon.source },
      unsigned: true as const
    }
  };
};

export const createPublishedIdentity = (
  inputs: DaimonPublishInputs,
  options: { contractManifestSha256: string; digest: string; platforms: Partial<Record<DaimonPublishArchitecture, PublishedPlatform>>; repository: string; tag: string }
): PublishedDaimonRuntimeIdentity => {
  matching(options.digest, SHA256, "index digest");
  matching(options.contractManifestSha256, SHA256, "contract manifest digest");
  const capabilityReceipts: Partial<Record<DaimonPublishArchitecture, string>> = {};
  for (const architecture of inputs.platforms) {
    const platform = options.platforms[architecture];
    if (!platform) throw new Error(`Missing published ${architecture} platform`);
    matching(platform.image_manifest_digest, SHA256, `${architecture} manifest digest`);
    capabilityReceipts[architecture] = matching(platform.capability_receipt_sha256, SHA256, `${architecture} receipt digest`);
  }
  // Every destination field comes from the repository actually pushed to, so an override cannot leave a stale pin.
  const separator = options.repository.indexOf("/");
  return {
    capability_receipts: capabilityReceipts,
    contract_manifest_sha256: options.contractManifestSha256,
    daimon: inputs.daimon,
    digest: options.digest,
    image: options.repository.slice(separator + 1),
    image_reference: `${options.repository}@${options.digest}`,
    platforms: options.platforms,
    registry: options.repository.slice(0, separator),
    tag: options.tag,
    version: "spawnfile.published-daimon-runtime-identity.v1"
  };
};

/** The runtimes.yaml `install` block a follow-up pin PR copies verbatim. */
export const renderRuntimesYamlPin = (identity: PublishedDaimonRuntimeIdentity): string => [
  "    install:",
  "      kind: container_image",
  `      image: ${identity.registry === "docker.io" ? identity.image : `${identity.registry}/${identity.image}`}`,
  `      tag: ${identity.tag}`,
  `      digest: ${identity.digest}`,
  "      capability_receipts:",
  ...Object.entries(identity.capability_receipts).map(([architecture, receipt]) => `        ${architecture}: ${receipt}`),
  `      contract_manifest_sha256: ${identity.contract_manifest_sha256}`
].join("\n");
