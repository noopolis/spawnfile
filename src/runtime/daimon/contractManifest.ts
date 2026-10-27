import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { SpawnfileError } from "../../shared/errors.js";
import { DAIMON_WAKE_MOMENTS, isDaimonWakeMoments } from "./wakeMoments.js";
import { DAIMON_V5_ENGINE_DESCRIPTORS } from "./engineDescriptors.generated.js";
import { DAIMON_PINNED_BROKER_DESCRIPTOR, DAIMON_PINNED_PORTABLE_DESCRIPTOR, DAIMON_PINNED_SECRET_SERVICE_DESCRIPTOR, parseDaimonEngineDescriptors, type DaimonEngineDescriptors } from "./engineDescriptorSchema.js";
import { daimonContractManifestV6Schema, daimonContractManifestV7Schema } from "./contractManifestSchema.js";

export const DAIMON_CONTRACT_MANIFEST_VERSION =
  "noopolis.daimon.runtime-contract-manifest.v7" as const;
export const DAIMON_CONTRACT_MANIFEST_SHA256 =
  "sha256:85de96d75cf1e02e0e88bd6e1dcce39a125c1d5b97f1eb9c01911a0d5c3316e8" as const;
export const DAIMON_CONTRACT_MANIFEST_FILE = "contract-manifest.json";
export const DAIMON_CONTRACT_MANIFEST_DIGEST_FILE = "contract-manifest.sha256";
export const DAIMON_RUNTIME_HOME_ROOT = "/var/lib/spawnfile/instances/daimon";
/** Compatibility aliases; all runtime facts come from the generated static descriptors. */
export const DAIMON_ENGINE_KINDS = Object.freeze(Object.keys(DAIMON_V5_ENGINE_DESCRIPTORS).sort());
export const DAIMON_ORGANIZATION_RUNTIME_CONFIG_VERSIONS = ["noopolis.daimon.organization-runtime.v1", "noopolis.daimon.organization-runtime.v2"] as const;
export const DAIMON_ENGINE_CREDENTIALS = { [DAIMON_PINNED_PORTABLE_DESCRIPTOR.id]: DAIMON_PINNED_PORTABLE_DESCRIPTOR.credentialMaterial } as const;
export const DAIMON_CODEX_SUBSCRIPTION_REALM = DAIMON_PINNED_PORTABLE_DESCRIPTOR.auth.realm;
export const DAIMON_GROK_SUBSCRIPTION_REALM = DAIMON_PINNED_BROKER_DESCRIPTOR.auth.realm;
export const DAIMON_GROK_ENGINE_BROKER = DAIMON_PINNED_BROKER_DESCRIPTOR.broker;
export const DAIMON_GROK_BROKER_MODELS = DAIMON_GROK_ENGINE_BROKER.worker.models;
export const DAIMON_GROK_BROKER_REASONING_EFFORTS = DAIMON_GROK_ENGINE_BROKER.worker.reasoningEfforts;
export type DaimonGrokBrokerModel = typeof DAIMON_GROK_BROKER_MODELS[number];
export type DaimonGrokBrokerReasoningEffort = typeof DAIMON_GROK_BROKER_REASONING_EFFORTS[number];
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
export const DAIMON_AGY_SUBSCRIPTION_REALM = DAIMON_PINNED_SECRET_SERVICE_DESCRIPTOR.auth.realm;

export type DaimonEngine = string;
export type DaimonPortableEngine = keyof typeof DAIMON_ENGINE_CREDENTIALS;
type DaimonCredentialMaterial = { readonly destinationRelativePath: string; readonly directoryMode: 448; readonly fileMode: 384; readonly sourceRelativePath: string; readonly sourceSlot: string };

export interface DaimonContractManifest {
  readonly engines: DaimonEngineDescriptors;
  readonly wakeMoments?: typeof DAIMON_WAKE_MOMENTS;
  readonly agySubscriptionRealm: typeof DAIMON_AGY_SUBSCRIPTION_REALM;
  readonly consumedConfigFields: readonly string[];
  readonly engineCredentialMaterial: Readonly<Record<string, DaimonCredentialMaterial>>;
  readonly codexSubscriptionRealm?: typeof DAIMON_CODEX_SUBSCRIPTION_REALM;
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
  readonly version: typeof DAIMON_CONTRACT_MANIFEST_VERSION | "noopolis.daimon.runtime-contract-manifest.v6" | "noopolis.daimon.runtime-contract-manifest.v5";
}

export interface VerifiedDaimonContractManifest {
  readonly digest: `sha256:${string}`;
  readonly manifest: DaimonContractManifest;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const expectedConfigFields = [
  "version", "host.bindHost", "host.port", "host.controlTokenEnv", "agents[].id",
  "agents[].name", "agents[].instructions", "agents[].workspacePath",
  "agents[].runtimeHomePath", "agents[].engine.kind", "agents[].engine.model",
  "agents[].engine.reasoningEffort", "agents[].engine.codexSandbox", "agents[].schedule.kind",
  "agents[].schedule.interval_ms", "agents[].schedule.cron",
  "agents[].schedule.timezone", "agents[].schedule.prompt",
  "agents[].schedule.jitter_seconds",
  "agents[].mcp", "agents[].moltnet", "agents[].memory", "agents[].attention"
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
  const v6 = root.version === "noopolis.daimon.runtime-contract-manifest.v6";
  const v7 = root.version === DAIMON_CONTRACT_MANIFEST_VERSION;
  const described = v6 || v7;
  if (v7 && !daimonContractManifestV7Schema.safeParse(root).success) return fail("has an invalid v7 schema");
  if (v6 && !daimonContractManifestV6Schema.safeParse(root).success) return fail("has an invalid v6 schema");
  if (!described && Object.hasOwn(root, "engines")) return fail("v5 must use the generated descriptor mirror");
  const legacyEngines = Object.fromEntries(Object.entries(DAIMON_V5_ENGINE_DESCRIPTORS).map(([id, entry]) => [id,
    entry.auth.staging === "portable-realm" ? { ...entry, auth: { ...entry.auth, staging: "portable-file", realm: null } } : entry
  ]));
  const engines = parseDaimonEngineDescriptors(described ? root.engines : legacyEngines);
  const engineKinds = Object.keys(engines).sort();
  const hasWakeMoments = Object.hasOwn(root, "wakeMoments");
  if (hasWakeMoments && !isDaimonWakeMoments(root.wakeMoments)) return fail("has an unsupported wakeMoments contract");
  const configFields = hasWakeMoments ? [...expectedConfigFields, DAIMON_WAKE_MOMENTS.configField] : expectedConfigFields;
  if (
    (!described && root.version !== "noopolis.daimon.runtime-contract-manifest.v5") ||
    !Array.isArray(root.supportedEngineKinds) ||
    root.supportedEngineKinds.join("\0") !== engineKinds.join("\0") ||
    !Array.isArray(root.consumedConfigFields) ||
    root.consumedConfigFields.join("\0") !== configFields.join("\0") ||
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
  if (!described && !exactKeys(materials, Object.keys(DAIMON_ENGINE_CREDENTIALS))) return fail("has unsupported credential material");
  for (const engine of Object.keys(DAIMON_ENGINE_CREDENTIALS) as DaimonPortableEngine[]) {
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
  if (v7) {
    if (canonicalJson(root.codexSubscriptionRealm) !== canonicalJson(DAIMON_CODEX_SUBSCRIPTION_REALM)) return fail("has unsafe Codex subscription realm material");
    const owners = Object.values(engines).filter((entry) => entry.auth.staging === "portable-realm");
    if (owners.length !== 1 || canonicalJson(owners[0]?.auth.realm) !== canonicalJson(root.codexSubscriptionRealm)) return fail("has inconsistent portable subscription realm material");
  }
  if (described) {
    const portable = Object.values(engines).filter((entry) => entry.auth.staging === "portable-file" || entry.auth.staging === "portable-realm");
    for (const descriptor of portable) {
      if (canonicalJson(materials[descriptor.id]) !== canonicalJson(descriptor.credentialMaterial)) return fail("has inconsistent engine credential material");
    }
    if (portable.length !== Object.keys(materials).length) return fail("has inconsistent engine credential material");
    const brokers = Object.values(engines).filter((entry) => entry.broker !== null);
    const broker = brokers[0];
    if (brokers.length !== 1 || !broker || canonicalJson(broker.broker) !== canonicalJson(root.grokEngineBroker)
      || canonicalJson(broker.auth.realm) !== canonicalJson(root.grokSubscriptionRealm)) return fail("has inconsistent engine broker material");
    const secretServices = Object.values(engines).filter((entry) => entry.auth.staging === "secret-service");
    const secretService = secretServices[0];
    if (secretServices.length !== 1 || !secretService || canonicalJson(secretService.auth.realm) !== canonicalJson(root.agySubscriptionRealm)) return fail("has inconsistent engine realm material");
  }
  return Object.freeze({
    engines: Object.freeze(engines),
    agySubscriptionRealm: Object.freeze({ ...DAIMON_AGY_SUBSCRIPTION_REALM }),
    consumedConfigFields: Object.freeze([...configFields]),
    ...(hasWakeMoments ? { wakeMoments: DAIMON_WAKE_MOMENTS } : {}),
    ...(v7 ? { codexSubscriptionRealm: Object.freeze({ ...DAIMON_CODEX_SUBSCRIPTION_REALM }) } : {}),
    engineCredentialMaterial: Object.freeze(described ? materials as Record<string, DaimonCredentialMaterial> : { ...DAIMON_ENGINE_CREDENTIALS }),
    grokSubscriptionRealm: Object.freeze({ ...DAIMON_GROK_SUBSCRIPTION_REALM }),
    grokEngineBroker: Object.freeze({ ...DAIMON_GROK_ENGINE_BROKER }),
    supportedEngineKinds: Object.freeze(engineKinds),
    wakeAcceptanceTypes: Object.freeze(["manual", "message", "schedule", "external"] as const),
    deliverySemantics: Object.freeze({
      activeDeliveryIdempotency: "unbounded-until-terminal", terminalReceiptHorizon: 2_048,
      recovery: "at-least-once-with-stable-wake-id", concurrentSameAgentTurns: false, externalEffectsExactlyOnce: false
    }),
    version: v7 ? DAIMON_CONTRACT_MANIFEST_VERSION : v6 ? "noopolis.daimon.runtime-contract-manifest.v6" : "noopolis.daimon.runtime-contract-manifest.v5"
  });
};

/** Capability comes from receipt-bound manifest content, never a runtime version. */
export const daimonSupportsWakeMoments = (manifest: DaimonContractManifest): boolean =>
  manifest.wakeMoments !== undefined;

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
