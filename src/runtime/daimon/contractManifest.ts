import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { SpawnfileError } from "../../shared/index.js";

export const DAIMON_CONTRACT_MANIFEST_VERSION =
  "noopolis.daimon.runtime-contract-manifest.v3" as const;
export const DAIMON_CONTRACT_MANIFEST_SHA256 =
  "sha256:401da56de1182a4c1834bc872ab3121d0b45d63486d729a02ff98d5627f30829" as const;
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
export const DAIMON_GROK_BROKER_MODELS = ["grok-4.6", "grok-4.5", "grok-build"] as const;
export const DAIMON_GROK_BROKER_REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type DaimonGrokBrokerModel = typeof DAIMON_GROK_BROKER_MODELS[number];
export type DaimonGrokBrokerReasoningEffort = typeof DAIMON_GROK_BROKER_REASONING_EFFORTS[number];
/**
 * Byte mirror of Daimon's `GROK_ENGINE_BROKER` (daimon
 * `src/contracts/runtimeContractManifest.ts`), attested key-for-key against the
 * vendored `contract-manifest.json` by `parseDaimonContractManifest`.
 */
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
  grokCliVersion: "1.0.34",
  grokCliBuild: "3736acbc8658",
  grokCliArtifacts: {
    arm64: { url: "https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-1.0.34-linux-aarch64", sha256: "39ab87666877d64ef3a40aa60fbe0c3b6a6acd7001b78fe60e2c76bb6cfc4a94", bytes: 136_090_504 },
    x64: { url: "https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-1.0.34-linux-x86_64", sha256: "be5905e107d2b8b5f3c142d21ecfe4c8fd32a913d2fd551b788707930c4dc80d", bytes: 163_035_648 }
  },
  worker: {
    modelId: "daimon-broker-grok",
    models: DAIMON_GROK_BROKER_MODELS,
    reasoningEfforts: DAIMON_GROK_BROKER_REASONING_EFFORTS,
    defaultModel: "grok-4.6",
    defaultReasoningEffort: "low",
    toolIds: ["run_terminal_cmd", "read_file", "grep", "list_dir", "search_tool", "use_tool"],
    visibleTools: ["grep", "list_dir", "read_file", "run_terminal_command", "search_tool", "use_tool"],
    maxTurns: 48,
    systemPromptSha256: "2c31c0085a54a4efbf9c0cf0b8124c56e47f38691b7f0c7fa233a74abaa8ddf8",
    configSha256: {
      "grok-4.6": { low: "eed6a451150a72b2cb528b30c23b3d51c7d3bc38c67a8985d4dcdf956ff214d3", medium: "8850502dbebf8918c5161c63efcc4ccf18719488300f4cec1deceb2c112b451f", high: "3ce44ace503362326b47149b528b942ce638fe146313d62502f248acf9c7333d" },
      "grok-4.5": { low: "7aa13e90b9bc08d1a018f48b7a84de1dab41db586627ee2d5a25f69011ba7e25", medium: "218ba37e57a6f02fa36b265b4e154e68e30bd2d4794feb130cc226fdda7732a9", high: "0bb4ad8bfa5062169b28422d1d534b45420d4e46b1e546bda1c578eb34303646" },
      "grok-build": { low: "83ac7202442286a65c359cc596b0b8db7bc4529ee70e98224f6cd6f66deb6878", medium: "0146313f28739888eb4e861f1bfb285f7ee4e0a9164669256ebdf6492a2790ce", high: "bbe72aaf70c417dc7007823a7e9e1a7d1fa8d57e50bde6f24036083b32bcc859" }
    },
    home: {
      directory: { uid: 0, group: "worker", mode: 0o1771 },
      sessionsDirectory: { relativePath: "sessions", uid: 0, group: "worker", mode: 0o1771 },
      readOnlyFiles: { names: ["config.toml", "managed_config.toml", "requirements.toml", "sandbox.toml", "trusted_folders.toml"], uid: 0, gid: 0, mode: 0o444 },
      sandboxEvents: { relativePath: "sessions/sandbox-events.jsonl", owner: "worker", group: "broker", mode: 0o640 },
      privateTmp: { relativeToWorkerHome: "tmp", owner: "worker", mode: 0o700 },
      sharedTmp: { paths: ["/tmp", "/var/tmp"], uid: 0, maxGroupExclusive: 2_200, otherMode: 0o4, mode: 0o1774 },
      spillDirectory: { relativeToRuntimeHome: "tool-output", owner: "organization", group: "worker", mode: 0o2750, fileMode: 0o640 }
    }
  },
  bounds: { promptBytes: 65_536, capabilityBytes: 4_096, capabilityBundleBytes: 8_196, outputBytes: 65_536 },
  controlProtocolVersion: "noopolis.daimon.engine-broker.v2",
  turnRecordVersions: ["noopolis.daimon.engine-broker-turn.v1", "noopolis.daimon.engine-broker-turn.v2"],
  serviceConfigVersions: ["noopolis.daimon.engine-broker-service.v1", "noopolis.daimon.engine-broker-service.v2"],
  turnLimits: {
    keys: ["maxRequests", "maxTokens", "timeoutMs"],
    v1Defaults: { maxRequests: 32, maxTokens: 300_000, timeoutMs: 240_000 },
    bounds: { maxRequests: [1, 48], maxTokens: [1, 10_000_000], timeoutMs: [1_000, 3_600_000] },
    limitReasons: ["tokens", "requests", "timeout", "none"],
    wakeMayOnlyLower: true,
    tokenCeilingOvershoot: "at-most-one-request",
    maxInFlightRequests: 1,
    requestUsageMaxTokens: 500_000,
    missingUsageEstimate: { inputBytesPerToken: 2, outputTokens: 4_096 }
  },
  wakeLimitEnvironment: { timeoutMs: "DAIMON_ENGINE_WAKE_TIMEOUT_MS", maxTokens: "DAIMON_ENGINE_WAKE_TOKEN_CEILING" },
  projectionVersion: "noopolis.daimon.grok-broker-projection.v1",
  slotPreflightVersion: "noopolis.daimon.grok-slot-preflight.v2",
  inferenceGrants: {
    requestKinds: ["request_inference_grant", "release_inference_grant"],
    purposes: ["judge", "optimizer"],
    tokenPrefix: "inference_",
    ttlMs: 600_000,
    limits: { maxRequests: 64, maxTokens: 2_000_000 },
    maxLiveGrants: 8,
    maxInFlightRequestsPerGrant: 1,
    bodyMembers: ["messages", "model", "reasoning_effort", "response_format", "stream", "stream_options"],
    messageRoles: ["system", "user", "assistant"],
    failureCodes: ["auth_stale", "grant_limit", "invalid_request", "unavailable"],
    ledgerVersion: "noopolis.daimon.inference-usage.v1",
    ledgerDedupeKey: ["grant", "request"],
    client: {
      modelId: "daimon-inference-grok",
      envKey: "DAIMON_INFERENCE_GRANT",
      configSha256: {
        "grok-4.6": { low: "79314d039f787e4ebfec7dacf57adc969086b948f564dec008f0ed6367e6062f", medium: "6f538de0547c0c4e6a3f04ae08595ceadadabb06b75f6b6ee4c428744bb95cd8", high: "5652656effa82f0c4f09cf8226b16e6140332a5a358b571194bb5563312367ac" },
        "grok-4.5": { low: "a07f7436f1268bb399ec233c65d3b3d8fb99a11a1f175f8da1ca133c9367bc74", medium: "1f4c0d4dad1f3b09419b5739db6423a09e0049abc091594c64123a75dd53dfb9", high: "ffbc33728b821e9854fbc7c93601e599225da421ecfd6ebf10d314afcc28d6f2" },
        "grok-build": { low: "ca15c6a562a008227d39c51d3a3a83715663089b3784e8b46debb1fb67b3c4a1", medium: "01783fb6beadcf6f8486fff0836820ad43fab5662b812a907fe9cfdb83e9804d", high: "98d16f2b7d12f4eb540d625c853e51d227933e204923e43e8b9b4176f10aca2c" }
      }
    }
  },
  artifacts: {
    sourceSha256: "c0082d4b366ffdb860d8154ee7f402b8f8be1f09d4eda277eda6965198ab6a75",
    x64Sha256: "69e2865c722606a71501bc38d8b9c4c2c397e748327a8077e51e040319d1280d",
    arm64Sha256: "16a3f89d84b7139d556b070a626c75ece224d5e05c52d48e045b38086c0a0382"
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
