import path from "node:path";

import { SpawnfileError } from "../shared/index.js";
import {
  DAIMON_ORGANIZATION_TARGET_ID,
  DAIMON_RUNTIME_ACCEPTANCE_STORE_DIRECTORY,
  DAIMON_RUNTIME_HOMES_DIRECTORY,
  DAIMON_WAKE_FUSE_DIRECTORY
} from "../runtime/daimon/config.js";
import {
  DAIMON_AGY_SUBSCRIPTION_REALM,
  DAIMON_GROK_BROKER_MODELS,
  DAIMON_GROK_BROKER_REASONING_EFFORTS,
  DAIMON_GROK_ENGINE_BROKER,
  DAIMON_GROK_SUBSCRIPTION_REALM,
  DAIMON_GROK_TURN_USAGE_LEDGER,
  DAIMON_RUNTIME_HOME_ROOT,
  type DaimonGrokBrokerModel,
  type DaimonGrokBrokerReasoningEffort
} from "../runtime/daimon/contractManifest.js";
import {
  DAIMON_GROK_WORKER_HOME_DIRECTORY,
  daimonGrokWorkerSandboxProfileSha256,
  renderDaimonGrokWorkerSandboxProfile,
  resolveDaimonGrokWorkerConfig
} from "../runtime/daimon/grokWorkerContract.js";
import { DAIMON_FIRST_WORKER_UID } from "../runtime/daimon/runtimeIdentity.js";
import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";

export const DAIMON_WORKER_ROOT = "/var/lib/daimon-workers";
export const DAIMON_GROK_WORKER_READ_ONLY_FILES = DAIMON_GROK_ENGINE_BROKER.worker.home.readOnlyFiles.names;
/** Container paths no Grok worker may read that nothing else guarantees to exist; provisioning creates them root-owned 0700 when absent. */
export const DAIMON_GROK_OPTIONAL_DENY_PATHS = ["/run/secrets", "/run/spawnfile", "/run/spawnfile-secrets", "/run/world"] as const;

/**
 * The organization runtime state directory — the parent of the durable wake
 * acceptance store. The ownership guard secures it to `0700 2000:2000` for
 * every Daimon organization; the acceptance store beneath it is also on every
 * Grok worker's sandbox deny list.
 */
export const DAIMON_ORGANIZATION_STATE_DIRECTORY = path.posix.join(
  DAIMON_RUNTIME_HOME_ROOT,
  DAIMON_ORGANIZATION_TARGET_ID,
  "state"
);

/**
 * Paths Grok 1.0.34's strict base profile grants (read or read-write). Grok
 * refuses to start when a deny entry equals or contains one of them (verified
 * for `/tmp`, `/var/tmp`, `/run`, `/etc` and `sessions`; `/tmp/sub` works), so a
 * deny entry must always sit strictly below every grant it touches.
 */
export const DAIMON_GROK_BASE_PROFILE_GRANTS = ["/bin", "/dev", "/etc", "/lib", "/proc", "/run", "/sbin", "/sys", "/tmp", "/usr", "/var", "/var/tmp"] as const;
export const DAIMON_GROK_MAX_REGISTERED_PATH_BYTES = 255;

/**
 * The canonical path rule Daimon's service parser and native launcher enforce:
 * absolute, no empty, `.` or `..` component, no trailing slash, and at most 255
 * bytes (the registration record's NUL-terminated 256-byte fields).
 */
export const assertCanonicalRegisteredPath = (label: string, value: string): string => {
  const components = value.split("/").slice(1);
  if (!value.startsWith("/") || value.length < 2 || value.endsWith("/") || components.some((part) => part === "" || part === "." || part === "..")
    || path.posix.normalize(value) !== value || value.includes("\0") || Buffer.byteLength(value) > DAIMON_GROK_MAX_REGISTERED_PATH_BYTES) {
    fail(`Grok worker ${label} is not a canonical registered path: ${JSON.stringify(value)}`);
  }
  return value;
};

export interface DaimonGrokRegistration {
  agentId: string;
  config: string;
  configSha256: string;
  denyPaths: string[];
  /** Deny entries the main entrypoint materializes after root provisioning (workspace resource backings); absent is allowed there, a symlink never. */
  deferredDenyPaths: string[];
  eventsPath: string;
  grokHome: string;
  home: string;
  model: DaimonGrokBrokerModel;
  profile: string;
  profilePath: string;
  profileSha256: string;
  /** `<home>/tmp`: the launcher's compiled `TMPDIR` for this worker. */
  privateTmp: string;
  reasoningEffort: DaimonGrokBrokerReasoningEffort;
  /** The organization runtime home whose `tool-output/` this worker reads. */
  runtimeHome: string;
  /** `<runtimeHome>/tool-output`: setgid spill directory in the worker's group. */
  spillDirectory: string;
  slot: number;
  uid: number;
  usageLedgerPath: string;
  workspace: string;
}

const nodeSlug = (nodeId: string): string => nodeId.replace(/^agent:/u, "")
  .toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");

const fail = (message: string): never => {
  throw new SpawnfileError("compile_error", message);
};

const declaredModel = (plan: RuntimeTargetPlan, agentId: string): { model: DaimonGrokBrokerModel; reasoningEffort: DaimonGrokBrokerReasoningEffort } => {
  const declared = plan.grokModelByNodeId?.[agentId];
  if (!declared || !(DAIMON_GROK_BROKER_MODELS as readonly string[]).includes(declared.model)
    || !(DAIMON_GROK_BROKER_REASONING_EFFORTS as readonly string[]).includes(declared.reasoningEffort)) {
    return fail(`Daimon Grok agent ${agentId} has no declared broker model and reasoning effort`);
  }
  return declared as { model: DaimonGrokBrokerModel; reasoningEffort: DaimonGrokBrokerReasoningEffort };
};

/**
 * Spawnfile-managed state roots no Grok worker needs: the shared Moltnet store
 * (server data, node/bridge configs, receipt stores, network state), per-agent
 * Moltnet open-mode token directories, and declared Mneme memory banks. A
 * worker reaches Moltnet and memory only through Daimon's MCP tools, which run
 * in the organization process, never by reading these files. Provisioning
 * creates each root-owned `0700` when absent so the mask always has a target.
 */
export const DAIMON_GROK_DENIED_STATE_ROOTS = ["/var/lib/spawnfile/agents", "/var/lib/spawnfile/memory", "/var/lib/spawnfile/moltnet"] as const;

const within = (candidate: string, root: string): boolean => candidate === root || candidate.startsWith(`${root}/`);

/**
 * One brokered worker's sandbox deny list.
 *
 * Daimon's own protected set for the agent (`grokSandboxProtectedPaths`: the
 * Grok bootstrap and realm, the AGY realm and unlock secret when any agent is
 * AGY, the wake-acceptance store, and every peer's runtime home and workspace)
 * is always kept verbatim, so a Daimon projection over the same inputs renders
 * the same profile. This deployment adds everything else the container
 * provisions that the worker does not need: the organization config directory
 * (all agents' instructions and any env files), every persistent mount of
 * every runtime plan (the worker's own tool state, credential home and memory
 * included — it reaches them only through Daimon), every other runtime
 * instance root, the shared Moltnet/agent/memory state roots, every workspace
 * resource backing path not linked from this agent's own workspace, the broker's
 * `/etc` and `/run` directories, the usage ledger and wake fuse, every other
 * worker's home, and the container secret roots.
 *
 * Allowed on purpose: the agent's own workspace (the worker's cwd), its own
 * runtime home directory itself (Daimon's tool-result spill contract names paths
 * under it; its contents are persistent mounts and denied), its own worker home,
 * and backing paths of resources linked into its own workspace (a mask over the
 * backing inode would also hide the agent's own resource through its link).
 *
 * Grok 1.0.34's strict base reads all of `/run`, `/var`, `/tmp` and `/etc`, and
 * macOS bind mounts ignore unix modes, so this list — not file modes — is the
 * boundary. Masks cannot nest: an added entry already covered by another entry
 * is dropped, and an added entry that would cover a Daimon entry is refused.
 */
export const resolveDaimonGrokWorkerDenyPaths = (
  plans: readonly RuntimeTargetPlan[],
  plan: RuntimeTargetPlan,
  agentId: string,
  workerHomes: readonly string[],
  ownHome: string
): string[] => {
  const instanceRoot = plan.instancePaths.instanceRoot ?? fail("Daimon Grok registrations require an instance root");
  const agents = Object.entries(plan.engineByNodeId ?? {});
  const ownWorkspace = path.posix.join(plan.instancePaths.workspacePath, "agents", nodeSlug(agentId));
  const ownRuntimeHome = path.posix.join(instanceRoot, DAIMON_RUNTIME_HOMES_DIRECTORY, nodeSlug(agentId));
  const peers = agents.filter(([id]) => id !== agentId).map(([id]) => nodeSlug(id));
  const daimonOwn = [
    DAIMON_GROK_SUBSCRIPTION_REALM.bootstrapMountPath,
    DAIMON_GROK_SUBSCRIPTION_REALM.durableMountPath,
    ...(agents.some(([, engine]) => engine === "agy") ? [DAIMON_AGY_SUBSCRIPTION_REALM.unlockMountPath, DAIMON_AGY_SUBSCRIPTION_REALM.durableMountPath] : []),
    path.posix.join(instanceRoot, DAIMON_RUNTIME_ACCEPTANCE_STORE_DIRECTORY),
    ...peers.flatMap((slug) => [
      path.posix.join(instanceRoot, DAIMON_RUNTIME_HOMES_DIRECTORY, slug),
      path.posix.join(plan.instancePaths.workspacePath, "agents", slug)
    ])
  ];
  const ownResourceBackings = new Set((plan.resources ?? [])
    .filter((resource) => within(resource.linkPath, ownWorkspace))
    .map((resource) => resource.backingPath));
  const added = [
    path.posix.dirname(plan.instancePaths.configPath),
    ...plans.flatMap((candidate) => (candidate.persistentMounts ?? []).map((mount) => mount.mount_path)),
    ...plans.filter((candidate) => candidate !== plan).flatMap((candidate) => [
      candidate.instancePaths.instanceRoot ?? path.posix.dirname(candidate.instancePaths.configPath),
      ...(candidate.envFiles ?? []).map((binding) => binding.filePath)
    ]),
    ...(plan.envFiles ?? []).map((binding) => binding.filePath),
    ...plans.flatMap((candidate) => candidate.resources ?? []).map((resource) => resource.backingPath)
      .filter((backing) => !ownResourceBackings.has(backing)),
    ...DAIMON_GROK_DENIED_STATE_ROOTS,
    path.posix.dirname(DAIMON_GROK_ENGINE_BROKER.registrationPath),
    path.posix.dirname(DAIMON_GROK_ENGINE_BROKER.controlSocketPath),
    DAIMON_GROK_TURN_USAGE_LEDGER.directoryPath,
    DAIMON_WAKE_FUSE_DIRECTORY,
    ...workerHomes.filter((home) => home !== ownHome),
    ...DAIMON_GROK_OPTIONAL_DENY_PATHS
  ].filter((entry) => entry.startsWith("/"));
  const grokHome = path.posix.join(ownHome, DAIMON_GROK_WORKER_HOME_DIRECTORY);
  const grants = [...DAIMON_GROK_BASE_PROFILE_GRANTS, ownWorkspace, grokHome, path.posix.join(grokHome, "sessions"), path.posix.join(ownHome, "tmp")];
  for (const entry of [...daimonOwn, ...added]) {
    const grant = grants.find((candidate) => within(candidate, entry));
    if (grant) fail(`Grok worker deny path ${entry} equals or contains the base profile grant ${grant}; Grok refuses such a profile`);
  }
  for (const entry of added) {
    if (within(ownWorkspace, entry) || within(ownHome, entry) || entry === ownRuntimeHome || within(ownRuntimeHome, entry)
      || [...ownResourceBackings].some((backing) => within(backing, entry))) {
      fail(`Grok worker deny path ${entry} would hide ${agentId}'s own workspace, home, or resources`);
    }
  }
  const candidates = [...new Set([...daimonOwn, ...added])];
  const daimonSet = new Set(daimonOwn);
  const denied = candidates.filter((entry) => daimonSet.has(entry)
    || !candidates.some((other) => other !== entry && within(entry, other))).sort();
  for (const entry of denied) {
    const ancestor = denied.find((other) => other !== entry && within(entry, other));
    if (ancestor) fail(`Grok worker deny path ${ancestor} would cover ${entry}; masks cannot nest`);
  }
  return denied;
};

export const resolveDaimonGrokRegistrations = (plans: RuntimeTargetPlan[]): DaimonGrokRegistration[] => {
  const entries = plans
    .filter((plan) => plan.runtimeName === "daimon")
    .flatMap((plan) => Object.entries(plan.engineByNodeId ?? {})
      .filter(([, engine]) => engine === "grok")
      .map(([agentId]) => ({ agentId, plan })))
    .sort((left, right) => left.agentId.localeCompare(right.agentId));
  const homes = entries.map((_, slot) => path.posix.join(DAIMON_WORKER_ROOT, String(DAIMON_FIRST_WORKER_UID + slot)));
  return entries.map(({ agentId, plan }, slot) => {
    if (nodeSlug(agentId) === "") fail(`Daimon Grok agent ${agentId} has no path-safe slug`);
    const home = assertCanonicalRegisteredPath("home", homes[slot]!);
    const grokHome = path.posix.join(home, DAIMON_GROK_WORKER_HOME_DIRECTORY);
    const instanceRoot = plan.instancePaths.instanceRoot ?? fail("Daimon Grok registrations require an instance root");
    const runtimeHome = assertCanonicalRegisteredPath("runtime home", path.posix.join(instanceRoot, DAIMON_RUNTIME_HOMES_DIRECTORY, nodeSlug(agentId)));
    const { model, reasoningEffort } = declaredModel(plan, agentId);
    const config = resolveDaimonGrokWorkerConfig(model, reasoningEffort);
    const denyPaths = resolveDaimonGrokWorkerDenyPaths(plans, plan, agentId, homes, home);
    const profile = renderDaimonGrokWorkerSandboxProfile(denyPaths);
    for (const [label, value] of [["GROK_HOME", grokHome], ["profile", path.posix.join(grokHome, "sandbox.toml")], ["events", path.posix.join(grokHome, DAIMON_GROK_ENGINE_BROKER.worker.home.sandboxEvents.relativePath)], ["private temp", path.posix.join(home, DAIMON_GROK_ENGINE_BROKER.worker.home.privateTmp.relativeToWorkerHome)]] as const) assertCanonicalRegisteredPath(label, value);
    // The launcher derives HOME, GROK_HOME=<home>/.grok and TMPDIR=<home>/tmp from the registered home, and the broker reads the profile from GROK_HOME.
    if (path.posix.dirname(path.posix.dirname(path.posix.join(grokHome, "sandbox.toml"))) !== home) fail(`Grok worker ${agentId} profile is not under its registered home`);
    const backings = new Set(plans.flatMap((candidate) => candidate.resources ?? []).map((resource) => resource.backingPath));
    return {
      deferredDenyPaths: denyPaths.filter((entry) => backings.has(entry)),
      agentId,
      config: config.bytes,
      configSha256: config.sha256,
      denyPaths,
      eventsPath: path.posix.join(grokHome, DAIMON_GROK_ENGINE_BROKER.worker.home.sandboxEvents.relativePath),
      grokHome,
      home,
      model,
      profile,
      profilePath: path.posix.join(grokHome, "sandbox.toml"),
      profileSha256: daimonGrokWorkerSandboxProfileSha256(denyPaths),
      privateTmp: path.posix.join(home, DAIMON_GROK_ENGINE_BROKER.worker.home.privateTmp.relativeToWorkerHome),
      reasoningEffort,
      runtimeHome,
      spillDirectory: path.posix.join(runtimeHome, DAIMON_GROK_ENGINE_BROKER.worker.home.spillDirectory.relativeToRuntimeHome),
      slot,
      uid: DAIMON_FIRST_WORKER_UID + slot,
      // Production keeps one container ledger: `spawnfile usage` and Daimon's
      // wake fuse both read it, so a per-slot file would hide Grok spend from both.
      usageLedgerPath: DAIMON_GROK_TURN_USAGE_LEDGER.filePath,
      workspace: assertCanonicalRegisteredPath("workspace", path.posix.join(plan.instancePaths.workspacePath, "agents", nodeSlug(agentId)))
    };
  });
};

/** `service.json` v2, exactly the shape Daimon's strict `parseEngineBrokerServiceConfig` accepts. */
export const renderDaimonGrokServiceConfig = (registrations: readonly DaimonGrokRegistration[]) => ({
  version: DAIMON_GROK_ENGINE_BROKER.serviceConfigVersions[1],
  credentialHome: DAIMON_GROK_ENGINE_BROKER.credentialHomePath,
  turnStore: DAIMON_GROK_ENGINE_BROKER.turnStorePath,
  registrations: registrations.map((entry) => ({
    agentId: entry.agentId,
    slot: entry.slot,
    workerUid: entry.uid,
    workspace: entry.workspace,
    profilePath: entry.profilePath,
    eventsPath: entry.eventsPath,
    profileSha256: entry.profileSha256,
    usageLedgerPath: entry.usageLedgerPath,
    limits: { ...DAIMON_GROK_ENGINE_BROKER.turnLimits.v1Defaults },
    model: { id: entry.model, reasoningEffort: entry.reasoningEffort }
  }))
});
