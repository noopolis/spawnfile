import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { SpawnfileError } from "../../shared/index.js";

export const DAIMON_CONTRACT_MANIFEST_VERSION =
  "noopolis.daimon.runtime-contract-manifest.v3" as const;
export const DAIMON_CONTRACT_MANIFEST_SHA256 =
  "sha256:444508888e9432f47d423dd996c0556823877c387a5715426cd4c315f28e8698" as const;
export const DAIMON_CONTRACT_MANIFEST_FILE = "contract-manifest.json";
export const DAIMON_CONTRACT_MANIFEST_DIGEST_FILE = "contract-manifest.sha256";
export const DAIMON_RUNTIME_HOME_ROOT = "/var/lib/spawnfile/instances/daimon";
export const DAIMON_ENGINE_KINDS = ["agy", "codex", "grok"] as const;
export const DAIMON_ORGANIZATION_RUNTIME_CONFIG_VERSIONS = ["noopolis.daimon.organization-runtime.v1", "noopolis.daimon.organization-runtime.v2"] as const;
export const DAIMON_ENGINE_CREDENTIALS = {
  codex: {
    destinationRelativePath: ".codex/auth.json",
    directoryMode: 0o700,
    fileMode: 0o600,
    sourceRelativePath: ".daimon-inbound/codex-auth",
    sourceSlot: "codex-auth"
  },
} as const;
export const DAIMON_GROK_SUBSCRIPTION_REALM = {
  agentCredentialRelativePath: ".grok/auth.json",
  bootstrapMountPath: "/var/lib/spawnfile/daimon/grok-bootstrap-auth",
  bootstrapSourceSlot: "grok-auth",
  directoryMode: 0o700,
  durableMountPath: "/var/lib/spawnfile/daimon/grok-subscription-realm",
  fileMode: 0o600,
  maxCredentialBytes: 64 * 1024
} as const;
export const DAIMON_GROK_ENGINE_BROKER = {
  nativeAbiVersion: 2,
  nativeExecutablePath: "/opt/daimon/bin/daimon-engine-broker",
  grokExecutablePath: "/usr/local/bin/grok",
  registrationPath: "/etc/daimon-engine-broker/registrations.bin",
  credentialHomePath: "/var/lib/spawnfile/daimon/grok-subscription-realm",
  turnStorePath: "/var/lib/spawnfile/daimon/grok-subscription-realm/turns",
  controlSocketPath: "/run/daimon-engine-broker/control.sock",
  backendSocketPath: "/run/daimon-engine-broker/backend.sock",
  launcherSocketPath: "/run/daimon-engine-broker/launcher.sock",
  serviceConfigPath: "/etc/daimon-engine-broker/service.json",
  providerProxy: { host: "127.0.0.1", port: 43_123 },
  mcpFacade: { host: "127.0.0.1", port: 43_124, path: "/mcp" },
  identities: { organizationUid: 2_000, brokerUid: 2_100, firstWorkerUid: 2_200 },
  bounds: { promptBytes: 65_536, capabilityBytes: 4_096, capabilityBundleBytes: 8_196, outputBytes: 65_536 },
  artifacts: {
    sourceSha256: "bdcab1e12dcc531ed8e56f890263ca23a9ee7bac468191dd598e143df4ff8c58",
    x64Sha256: "e3fe2738fc8a979861085b4003bf2d5d7c284874897cb6ec2e2e2383211768bd",
    arm64Sha256: "ad44e02c38e6a3207ac4a3d5fd98b6d2e55341ce42dfd2f07204bbe54a7a653d"
  }
} as const;
/**
 * Where the Daimon broker writes its per-turn usage ledger, and what this
 * compiler provisions. Deliberately kept out of `DAIMON_GROK_ENGINE_BROKER`:
 * that object's canonical bytes are digest-pinned and attested against the
 * runtime image at compile time, so a new key there would make every pinned
 * image fail to attest. Mirrors `TURN_USAGE_LEDGER` in
 * `daimon/src/runtime/turnUsageLedger.ts`.
 */
export const DAIMON_GROK_TURN_USAGE_LEDGER = {
  version: "noopolis.daimon.turn-usage.v1",
  directoryPath: "/var/lib/spawnfile/daimon/usage",
  filePath: "/var/lib/spawnfile/daimon/usage/usage.jsonl",
  rotatedFilePath: "/var/lib/spawnfile/daimon/usage/usage.jsonl.1",
  directoryMode: 0o750,
  fileMode: 0o640,
  /**
   * Mirrors `TURN_USAGE_ROTATE_BYTES` in `daimon/src/runtime/turnUsageLedger.ts`
   * (Spawnfile must not import from `daimon/`, so this is the Spawnfile-side
   * copy of the same agreed number). It is a LOWER bound on the size of a
   * rotated generation, not an upper one: the broker rotates on the append
   * *after* the file reaches this size, so `usage.jsonl.1` is always at least
   * this large and the line that crossed the bound overshoots it. Anything
   * sizing a read of one generation must therefore leave headroom above this
   * number rather than matching it (see
   * `DEFAULT_DOCKER_PROBE_MAX_BUFFER_BYTES`).
   */
  rotateBytes: 64 * 1024 * 1024
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
  readonly grokSubscriptionRealm: typeof DAIMON_GROK_SUBSCRIPTION_REALM;
  readonly grokEngineBroker: typeof DAIMON_GROK_ENGINE_BROKER;
  readonly supportedEngineKinds: readonly DaimonEngine[];
  readonly wakeAcceptanceTypes: readonly ["manual", "message", "schedule", "external"];
  readonly deliverySemantics: Readonly<{
    activeDeliveryIdempotency: "unbounded-until-terminal";
    terminalReceiptHorizon: 2_048;
    recovery: "at-least-once-with-stable-wake-id";
    concurrentSameAgentTurns: false;
    externalEffectsExactlyOnce: false;
  }>;
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
  "agents[].runtimeHomePath", "agents[].engine.kind", "agents[].schedule.kind",
  "agents[].schedule.interval_ms", "agents[].schedule.cron",
  "agents[].schedule.timezone", "agents[].schedule.prompt",
  "agents[].schedule.jitter_seconds",
  "agents[].mcp", "agents[].moltnet", "agents[].memory"
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

const matchesGrokRealm = (value: unknown): value is typeof DAIMON_GROK_SUBSCRIPTION_REALM => {
  const realm = asRecord(value, "Grok subscription realm");
  return exactKeys(realm, [
    "agentCredentialRelativePath", "bootstrapMountPath", "bootstrapSourceSlot",
    "directoryMode", "durableMountPath", "fileMode", "maxCredentialBytes"
  ]) && Object.entries(DAIMON_GROK_SUBSCRIPTION_REALM)
    .every(([name, expected]) => realm[name] === expected);
};

const matchesGrokEngineBroker = (value: unknown): value is typeof DAIMON_GROK_ENGINE_BROKER => {
  const broker = asRecord(value, "Grok engine broker");
  if (!exactKeys(broker, Object.keys(DAIMON_GROK_ENGINE_BROKER))) return false;
  return canonicalJson(broker) === canonicalJson(DAIMON_GROK_ENGINE_BROKER);
};

export const parseDaimonContractManifest = (raw: unknown): DaimonContractManifest => {
  const root = asRecord(raw, "root");
  if (
    root.version !== DAIMON_CONTRACT_MANIFEST_VERSION ||
    !Array.isArray(root.supportedEngineKinds) ||
    root.supportedEngineKinds.join("\0") !== "agy\0codex\0grok" ||
    !Array.isArray(root.consumedConfigFields) ||
    root.consumedConfigFields.join("\0") !== expectedConfigFields.join("\0") ||
    !Array.isArray(root.wakeAcceptanceTypes) ||
    root.wakeAcceptanceTypes.join("\0") !== "manual\0message\0schedule\0external"
  ) return fail("has an unsupported version or configuration contract");
  const v2 = asRecord(root.organizationRuntimeConfigV2Schema, "organizationRuntimeConfigV2Schema");
  const v2Properties = asRecord(v2.properties, "organizationRuntimeConfigV2Schema.properties");
  const v2Agents = asRecord(v2Properties.agents, "organizationRuntimeConfigV2Schema.properties.agents");
  const v2Agent = asRecord(v2Agents.items, "organizationRuntimeConfigV2Schema.properties.agents.items");
  const v2AgentProperties = asRecord(v2Agent.properties, "organizationRuntimeConfigV2Schema.properties.agents.items.properties");
  const schedule = asRecord(v2AgentProperties.schedule, "organizationRuntimeConfigV2Schema schedule");
  if (v2.$id !== "noopolis.daimon.organization-runtime.v2" || !Array.isArray(schedule.oneOf) || schedule.oneOf.length !== 3) return fail("does not attest the organization runtime v2 schedule contract");
  const semantics = asRecord(root.deliverySemantics, "deliverySemantics");
  if (!exactKeys(semantics, ["activeDeliveryIdempotency", "terminalReceiptHorizon", "recovery", "concurrentSameAgentTurns", "externalEffectsExactlyOnce"]) ||
    semantics.activeDeliveryIdempotency !== "unbounded-until-terminal" || semantics.terminalReceiptHorizon !== 2_048 ||
    semantics.recovery !== "at-least-once-with-stable-wake-id" || semantics.concurrentSameAgentTurns !== false || semantics.externalEffectsExactlyOnce !== false) return fail("has unsupported delivery semantics");
  const materials = asRecord(root.engineCredentialMaterial, "engineCredentialMaterial");
  if (!exactKeys(materials, ["codex"])) return fail("has unsupported credential material");
  for (const engine of ["codex"] as const) {
    if (!matchesCredentialMaterial(materials[engine], DAIMON_ENGINE_CREDENTIALS[engine])) {
      return fail(`has unsafe ${engine} credential material`);
    }
  }
  if (!matchesAgyRealm(root.agySubscriptionRealm)) {
    return fail("has unsafe AGY subscription realm material");
  }
  if (!matchesGrokRealm(root.grokSubscriptionRealm)) {
    return fail("has unsafe Grok subscription realm material");
  }
  if (!matchesGrokEngineBroker(root.grokEngineBroker)) {
    return fail("has unsafe Grok engine broker material");
  }
  return Object.freeze({
    agySubscriptionRealm: Object.freeze({ ...DAIMON_AGY_SUBSCRIPTION_REALM }),
    consumedConfigFields: Object.freeze([...expectedConfigFields]),
    engineCredentialMaterial: Object.freeze({ ...DAIMON_ENGINE_CREDENTIALS }),
    grokSubscriptionRealm: Object.freeze({ ...DAIMON_GROK_SUBSCRIPTION_REALM }),
    grokEngineBroker: Object.freeze({ ...DAIMON_GROK_ENGINE_BROKER }),
    supportedEngineKinds: Object.freeze([...DAIMON_ENGINE_KINDS]),
    wakeAcceptanceTypes: Object.freeze(["manual", "message", "schedule", "external"] as const),
    deliverySemantics: Object.freeze({
      activeDeliveryIdempotency: "unbounded-until-terminal", terminalReceiptHorizon: 2_048,
      recovery: "at-least-once-with-stable-wake-id", concurrentSameAgentTurns: false, externalEffectsExactlyOnce: false
    }),
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
