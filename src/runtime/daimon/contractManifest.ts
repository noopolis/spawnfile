import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { SpawnfileError } from "../../shared/index.js";

export const DAIMON_CONTRACT_MANIFEST_VERSION =
  "noopolis.daimon.runtime-contract-manifest.v1" as const;
export const DAIMON_CONTRACT_MANIFEST_FILE = "contract-manifest.json";
export const DAIMON_CONTRACT_MANIFEST_DIGEST_FILE = "contract-manifest.sha256";
export const DAIMON_RUNTIME_HOME_ROOT = "/var/lib/spawnfile/instances/daimon";
export const DAIMON_ENGINE_KINDS = ["agy", "codex", "grok"] as const;
export const DAIMON_ENGINE_CREDENTIALS = {
  codex: {
    destinationRelativePath: ".codex/auth.json",
    directoryMode: 0o700,
    fileMode: 0o600,
    sourceRelativePath: ".daimon-inbound/codex-auth",
    sourceSlot: "codex-auth"
  },
  grok: {
    destinationRelativePath: ".grok/auth.json",
    directoryMode: 0o700,
    fileMode: 0o600,
    sourceRelativePath: ".daimon-inbound/grok-auth",
    sourceSlot: "grok-auth"
  }
} as const;
export const DAIMON_AGY_SUBSCRIPTION_REALM = {
  directoryMode: 0o700,
  durableMountPath: "/var/lib/spawnfile/daimon/agy-subscription-realm",
  fileMode: 0o600,
  maxUnlockBytes: 4_096,
  unlockMountPath: "/var/lib/spawnfile/daimon/agy-unlock-secret",
  unlockSourceSlot: "agy-unlock-secret"
} as const;

export type DaimonEngine = typeof DAIMON_ENGINE_KINDS[number];
export type DaimonPortableEngine = keyof typeof DAIMON_ENGINE_CREDENTIALS;
type DaimonCredentialMaterial = (typeof DAIMON_ENGINE_CREDENTIALS)[DaimonPortableEngine];

export interface DaimonContractManifest {
  readonly agySubscriptionRealm: typeof DAIMON_AGY_SUBSCRIPTION_REALM;
  readonly consumedConfigFields: readonly string[];
  readonly engineCredentialMaterial: Readonly<Record<DaimonPortableEngine, DaimonCredentialMaterial>>;
  readonly supportedEngineKinds: readonly DaimonEngine[];
  readonly version: typeof DAIMON_CONTRACT_MANIFEST_VERSION;
}

export interface VerifiedDaimonContractManifest {
  readonly digest: `sha256:${string}`;
  readonly manifest: DaimonContractManifest;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const expectedConfigFields = [
  "version", "host.bindHost", "host.port", "host.controlTokenEnv", "agents[].id",
  "agents[].name", "agents[].instructions", "agents[].workspacePath",
  "agents[].runtimeHomePath", "agents[].engine.kind"
] as const;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

const fail = (message: string): never => {
  throw new SpawnfileError("runtime_error", `Daimon runtime contract manifest ${message}`);
};

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = asRecord(value, "JSON value");
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};

const matchesCredentialMaterial = (
  value: unknown,
  expected: DaimonCredentialMaterial
): value is DaimonCredentialMaterial => {
  const material = asRecord(value, "engine credential material");
  return exactKeys(material, ["destinationRelativePath", "directoryMode", "fileMode", "sourceRelativePath", "sourceSlot"])
    && material.destinationRelativePath === expected.destinationRelativePath
    && material.directoryMode === expected.directoryMode
    && material.fileMode === expected.fileMode
    && material.sourceRelativePath === expected.sourceRelativePath
    && material.sourceSlot === expected.sourceSlot;
};

const matchesAgyRealm = (value: unknown): value is typeof DAIMON_AGY_SUBSCRIPTION_REALM => {
  const realm = asRecord(value, "AGY subscription realm");
  return exactKeys(realm, [
    "directoryMode", "durableMountPath", "fileMode", "maxUnlockBytes",
    "unlockMountPath", "unlockSourceSlot"
  ])
    && Object.entries(DAIMON_AGY_SUBSCRIPTION_REALM)
      .every(([name, expected]) => realm[name] === expected);
};

export const parseDaimonContractManifest = (raw: unknown): DaimonContractManifest => {
  const root = asRecord(raw, "root");
  if (
    root.version !== DAIMON_CONTRACT_MANIFEST_VERSION ||
    !Array.isArray(root.supportedEngineKinds) ||
    root.supportedEngineKinds.join("\0") !== "agy\0codex\0grok" ||
    !Array.isArray(root.consumedConfigFields) ||
    root.consumedConfigFields.join("\0") !== expectedConfigFields.join("\0")
  ) return fail("has an unsupported version or configuration contract");
  const materials = asRecord(root.engineCredentialMaterial, "engineCredentialMaterial");
  if (!exactKeys(materials, ["codex", "grok"])) return fail("has unsupported credential material");
  for (const engine of ["codex", "grok"] as const) {
    if (!matchesCredentialMaterial(materials[engine], DAIMON_ENGINE_CREDENTIALS[engine])) {
      return fail(`has unsafe ${engine} credential material`);
    }
  }
  if (!matchesAgyRealm(root.agySubscriptionRealm)) {
    return fail("has unsafe AGY subscription realm material");
  }
  return Object.freeze({
    agySubscriptionRealm: Object.freeze({ ...DAIMON_AGY_SUBSCRIPTION_REALM }),
    consumedConfigFields: Object.freeze([...expectedConfigFields]),
    engineCredentialMaterial: Object.freeze({ ...DAIMON_ENGINE_CREDENTIALS }),
    supportedEngineKinds: Object.freeze([...DAIMON_ENGINE_KINDS]),
    version: DAIMON_CONTRACT_MANIFEST_VERSION
  });
};

export const assertDaimonRuntimeHome = (candidate: string): string => {
  if (!path.posix.isAbsolute(candidate)) fail("runtime home must be an absolute POSIX path");
  const normalized = path.posix.normalize(candidate);
  const relative = path.posix.relative(DAIMON_RUNTIME_HOME_ROOT, normalized);
  if (!relative || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
    fail("runtime home escapes the caller-owned Daimon root");
  }
  return normalized;
};

export const readVerifiedDaimonContractManifest = async (
  runtimeRoot: string
): Promise<VerifiedDaimonContractManifest> => {
  const manifestPath = path.join(runtimeRoot, DAIMON_CONTRACT_MANIFEST_FILE);
  const digestPath = path.join(runtimeRoot, DAIMON_CONTRACT_MANIFEST_DIGEST_FILE);
  let bytes: Buffer;
  let sidecar: string;
  try {
    [bytes, sidecar] = await Promise.all([readFile(manifestPath), readFile(digestPath, "utf8")]);
  } catch {
    return fail("is missing its packaged bytes or digest sidecar");
  }
  const source = bytes.toString("utf8");
  if (!source.endsWith("\n") || source.includes("\r")) return fail("is not canonical UTF-8 JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return fail("is not valid JSON");
  }
  if (`${canonicalJson(parsed)}\n` !== source) return fail("is not canonical JSON");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (sidecar !== `sha256:${digest}\n` || !SHA256.test(digest)) return fail("digest sidecar does not match its bytes");
  return Object.freeze({ digest: `sha256:${digest}`, manifest: parseDaimonContractManifest(parsed) });
};
