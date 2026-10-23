import { DAIMON_PACKAGE_NAME } from '../../runtime/daimon/packageName.js';
import { readFile } from "node:fs/promises";
import type { Socket } from "node:net";
import path from "node:path";

import { SpawnfileError } from "../../shared/index.js";
import { DAIMON_ENGINE_CREDENTIALS, DAIMON_GROK_ENGINE_BROKER, type DaimonGrokBrokerModel, type DaimonGrokBrokerReasoningEffort } from "../../runtime/daimon/contractManifest.js";
import { parseTrainingBrokerDeclaration } from "./broker/declaration.js";
import { TRAINING_BROKER_DECLARATION_FILE, TRAINING_PAIDEIA_ROOT, TRAINING_SLOTS_FILE, trainingSlotDescriptors } from "./broker/paths.js";
import { loadDaimonProjectionModule, resolveTrainingSlotProjection } from "./broker/projection.js";
import { recycleTrainingSlot } from "./broker/recycleClient.js";

/** Paideia's slot freshness floor for this trial: the receipt must echo the nonce at no lower generation. */
export interface TrainingSubjectFreshness { expectedNonce: string; minGeneration: number }
/** The evaluator-created per-trial directories (Paideia `TrialPaths`); only Codex subjects live in them. */
export interface TrainingSubjectTrialRoots { workspace: string; runtimeHome: string }
export type TrainingSubjectEvaluatorRole = "run-root" | "context" | "sealed-inputs" | "judge-home" | "slot-ledger";

/** `paideia.daimon-native.launch.v2` `broker`, structurally `grokBrokerLaunchSchema` of Paideia 0.1.1. */
export interface TrainingSubjectBrokerSection {
  projectionVersion: typeof DAIMON_GROK_ENGINE_BROKER.projectionVersion;
  workerConfigVariant: "unclocked" | "clocked";
  projectionSha256: string;
  slot: number;
  workerUid: number;
  workerHomePath: string;
  architecture: "arm64" | "x64";
  usageLedgerPath: string;
  seccompProfileSha256: string;
  profileSha256: string;
  denyPaths: string[];
  limits: { maxRequests: number; maxTokens: number; timeoutMs: number };
  evaluatorPaths: { role: TrainingSubjectEvaluatorRole; path: string }[];
  slotPreflightReceipt: string;
  expectedNonce: string;
  minGeneration: number;
}

export type TrainingSubjectAgent =
  | { id: string; engine: "codex"; model: string }
  | { id: string; engine: "grok"; model: DaimonGrokBrokerModel; reasoningEffort: DaimonGrokBrokerReasoningEffort };

export interface TrainingSubjectLease {
  agent: TrainingSubjectAgent;
  workspace: { source: string; target: string };
  projections: { role: "home" | "memory" | "transport"; source: string; target: string }[];
  credentials: { source: string; target: string }[];
  broker?: TrainingSubjectBrokerSection;
  /** Named slot roots: always `workspace`, `home` and `control`, plus engine-specific roots (Grok adds `context`). */
  roots: Record<string, string> & { workspace: string; home: string; control: string };
  /** `control` is the worker control port; `moltnet` and `bridge` are provisioner-owned extras. */
  ports: { moltnet: number; control: number; bridge: number };
  /** Recycled generation; Grok only. */
  generation?: number;
  /** Subject environment Spawnfile owns for this lease. */
  env: Record<string, string>;
}

export interface LeaseTrainingSubjectOptions {
  slot: number;
  engine: string;
  agentId: string;
  /** The compiled Codex model; Grok's model comes from the broker declaration and, if given, must match it. */
  model?: string;
  /** Required for Grok, refused for Codex (which has no recycle). */
  freshness?: TrainingSubjectFreshness;
  /** Required for Codex; a Grok subject lives at the container's fixed slot roots. */
  trialRoots?: TrainingSubjectTrialRoots;
  signal: AbortSignal;
  /** Resolves Daimon's public `Daimon/runtime` export. */
  loadDaimon?: () => Promise<unknown>;
  /** Test seams: the supervisor connection and the declaration file. */
  connect?: () => Socket;
  declarationFile?: string;
  slotsFile?: string;
}

/** The fixed read-only container leaf the training launch binds the Codex login to. */
export const TRAINING_CODEX_CREDENTIAL_INGRESS = "/run/paideia-auth/codex";
const NONCE = /^[a-f0-9]{64}$/u;
const invalid = (message: string): never => { throw new SpawnfileError("validation_error", message); };
const refused = (message: string): never => { throw new SpawnfileError("runtime_error", message); };

const canonical = (label: string, value: unknown): string => {
  if (typeof value !== "string" || !path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
    || value.length < 2 || value.endsWith("/") || value.includes(",")) invalid(`Training subject ${label} must be a canonical absolute path`);
  return value as string;
};

/**
 * Lease one training slot for an engine-neutral subject and return everything
 * `paideia.daimon-native.launch.v2` must carry about it.
 *
 * Spawnfile owns the container, its slots, the broker declaration and
 * registration, the projection inputs, the recycle verb and the credential
 * ingress paths, so an integration names an engine and an agent and never a
 * container path. Grok recycles the slot with the evaluator's nonce and binds
 * the supervisor's receipt; Codex derives its per-trial projections from the
 * evaluator's own trial roots. Any other engine is refused.
 */
export const leaseTrainingSubject = async (options: LeaseTrainingSubjectOptions): Promise<TrainingSubjectLease> => {
  options.signal.throwIfAborted();
  if (!Number.isInteger(options.slot) || options.slot < 0) invalid("Training subject lease requires a slot index");
  if (options.engine === "grok") return leaseGrokSubject(options);
  if (options.engine === "codex") return leaseCodexSubject(options);
  return invalid(`Training subject engine ${String(options.engine)} is not supported; lease a codex or grok subject`);
};

const leaseGrokSubject = async (options: LeaseTrainingSubjectOptions): Promise<TrainingSubjectLease> => {
  const freshness = options.freshness;
  if (!freshness || !NONCE.test(freshness.expectedNonce) || !Number.isSafeInteger(freshness.minGeneration) || freshness.minGeneration < 1) {
    return invalid("A Grok training subject requires freshness with a 32-byte hex nonce and a generation floor of at least 1");
  }
  const declaration = parseTrainingBrokerDeclaration(JSON.parse(await readFile(options.declarationFile ?? TRAINING_BROKER_DECLARATION_FILE, "utf8")));
  if (declaration.agentId !== options.agentId) invalid(`The training broker declares ${declaration.agentId}, not ${options.agentId}`);
  if (options.model !== undefined && options.model !== declaration.model) invalid(`The training broker declares model ${declaration.model}, not ${options.model}`);
  if (options.slot >= declaration.slots) invalid(`Training slot ${options.slot} is outside the declared pool of ${declaration.slots}`);
  const descriptor = trainingSlotDescriptors(declaration.slots)[options.slot]!;
  // Resolved before the recycle: a Daimon whose contract drifted must refuse without wiping the slot.
  const daimon = await loadDaimonProjectionModule(options.loadDaimon);
  const { registration, projection, projectionSha256 } = await resolveTrainingSlotProjection(declaration, options.slot, daimon);
  options.signal.throwIfAborted();
  const result = await recycleTrainingSlot({ slot: options.slot, nonce: freshness.expectedNonce, signal: options.signal,
    ...(options.connect ? { connect: options.connect } : {}) });
  if (result.receipt !== descriptor.preflightReceipt) refused("The slot supervisor published its receipt outside the leased slot root");
  if (result.generation < freshness.minGeneration) refused("The slot supervisor published a generation below the evaluator freshness floor");
  options.signal.throwIfAborted();
  const roots = {
    workspace: descriptor.workspace, home: descriptor.runtimeHome, control: descriptor.state, workerHome: descriptor.workerHome,
    usageLedger: descriptor.usageLedger, preflightReceipt: descriptor.preflightReceipt, context: TRAINING_PAIDEIA_ROOT
  };
  return {
    agent: { id: declaration.agentId, engine: "grok", model: declaration.model, reasoningEffort: declaration.reasoningEffort },
    workspace: { source: descriptor.workspace, target: descriptor.workspace },
    // The projection digest binds exactly the slot workspace and runtime home; nothing else may be writable.
    projections: [{ role: "home", source: descriptor.runtimeHome, target: descriptor.runtimeHome }],
    credentials: [],
    broker: {
      projectionVersion: DAIMON_GROK_ENGINE_BROKER.projectionVersion,
      workerConfigVariant: projection.workerConfigVariant as "clocked",
      projectionSha256,
      slot: options.slot,
      workerUid: descriptor.workerUid,
      workerHomePath: descriptor.workerHome,
      architecture: declaration.architecture,
      usageLedgerPath: descriptor.usageLedger,
      seccompProfileSha256: declaration.seccompProfileSha256,
      // Verbatim provisioner values the digest binds: a deny list re-derived from evaluatorPaths would fork it.
      profileSha256: registration.profileSha256,
      denyPaths: [...registration.denyPaths],
      limits: { ...declaration.limits },
      evaluatorPaths: descriptor.evaluatorPaths.map((row) => ({ role: row.role, path: row.path })),
      slotPreflightReceipt: descriptor.preflightReceipt,
      expectedNonce: freshness.expectedNonce,
      minGeneration: freshness.minGeneration
    },
    roots,
    ports: { moltnet: descriptor.ports.moltnet, control: descriptor.ports.workerControl, bridge: descriptor.ports.bridge },
    generation: result.generation,
    env: { [DAIMON_GROK_ENGINE_BROKER.slotRouting.slotEnvironment]: String(options.slot) }
  };
};

/** Indirect specifier: Daimon is an in-image runtime peer, never a Spawnfile source dependency. */
const loadDaimonRuntime = async (): Promise<unknown> => {
  const packageName = `${DAIMON_PACKAGE_NAME}/runtime`;
  return import(packageName);
};

/** The Codex credential leaf Daimon reads, from its public export, refused unless it equals the vendored manifest. */
const codexCredentialRelativePath = async (load: () => Promise<unknown> = loadDaimonRuntime): Promise<string> => {
  let daimon: { ENGINE_CREDENTIAL_MATERIAL?: { codex?: { sourceRelativePath?: unknown } } };
  try { daimon = await load() as typeof daimon; }
  catch { return refused(`The training image must install ${DAIMON_PACKAGE_NAME} with its public /runtime export`); }
  const relative = daimon?.ENGINE_CREDENTIAL_MATERIAL?.codex?.sourceRelativePath;
  if (relative !== DAIMON_ENGINE_CREDENTIALS.codex.sourceRelativePath) {
    return refused("The installed Daimon Codex credential material differs from this compiler's vendored manifest");
  }
  return relative;
};

/** Ports from the leased slot's own `slots.json` block (offsets 0=Moltnet, 1=worker control, 2=bridge), refused outside it. */
const leasedSlotPorts = async (slot: number, file: string): Promise<TrainingSubjectLease["ports"]> => {
  let entry: { index?: unknown; ports?: { base?: unknown; count?: unknown } } | undefined;
  try {
    const document = JSON.parse(await readFile(file, "utf8")) as { slots?: unknown };
    entry = Array.isArray(document.slots) ? (document.slots as NonNullable<typeof entry>[]).find((row) => row?.index === slot) : undefined;
  } catch { return refused("The training slots manifest is missing or unreadable"); }
  const base = entry?.ports?.base, count = entry?.ports?.count;
  if (!Number.isSafeInteger(base) || !Number.isSafeInteger(count) || (base as number) < 1 || (count as number) < 3) {
    return refused(`Training slot ${slot} has no usable port block in the slots manifest`);
  }
  const first = base as number;
  const offsets = { moltnet: first, control: first + 1, bridge: first + 2 };
  if (Object.values(offsets).some((port) => port >= first + (count as number) || port > 65_535)) {
    return refused(`Training slot ${slot} ports fall outside its leased block`);
  }
  return offsets;
};

const leaseCodexSubject = async (options: LeaseTrainingSubjectOptions): Promise<TrainingSubjectLease> => {
  if (options.freshness !== undefined) invalid("A Codex training subject has no slot recycle; freshness does not apply");
  if (typeof options.model !== "string" || !options.model.trim()) invalid("A Codex training subject requires its compiled model");
  if (!options.trialRoots) return invalid("A Codex training subject requires the evaluator's trial roots");
  const workspace = canonical("workspace", options.trialRoots.workspace);
  const runtimeHome = canonical("runtime home", options.trialRoots.runtimeHome);
  const ports = await leasedSlotPorts(options.slot, options.slotsFile ?? TRAINING_SLOTS_FILE);
  const relative = await codexCredentialRelativePath(options.loadDaimon);
  options.signal.throwIfAborted();
  // Codex's writable data sits beside the workspace, disjoint from the evaluator runtime and its controls.
  const parent = path.posix.dirname(workspace);
  const home = path.posix.join(parent, "home"), memory = path.posix.join(parent, "memory");
  const transport = path.posix.join(runtimeHome, "native/moltnet");
  const roots = { workspace, home, memory, transport, control: path.posix.join(runtimeHome, "native/root-control/acceptance"),
    inputs: path.posix.join(runtimeHome, "native/root-control/inputs") };
  const values = Object.values(roots);
  if (new Set(values).size !== values.length || values.some((value) => value !== workspace && value.startsWith(`${workspace}/`))) {
    invalid("Codex trial roots must not overlap the subject workspace");
  }
  return {
    agent: { id: options.agentId, engine: "codex", model: options.model! },
    workspace: { source: workspace, target: workspace },
    projections: [{ role: "home", source: home, target: home }, { role: "memory", source: memory, target: memory },
      { role: "transport", source: transport, target: transport }],
    // The read-only container leaf is the sole ingress; the child stages it into exactly this target
    // (`stageTrainingAuth` from `spawnfile/auth`), never overwriting a renewed credential.
    credentials: [{ source: TRAINING_CODEX_CREDENTIAL_INGRESS, target: path.posix.join(home, relative) }],
    roots,
    ports,
    env: {}
  };
};
