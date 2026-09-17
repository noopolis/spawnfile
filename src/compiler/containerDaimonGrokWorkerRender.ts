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
export const DAIMON_GROK_OPTIONAL_DENY_PATHS = ["/run/secrets", "/run/spawnfile", "/run/spawnfile-secrets"] as const;

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

export interface DaimonGrokRegistration {
  agentId: string;
  config: string;
  configSha256: string;
  denyPaths: string[];
  eventsPath: string;
  grokHome: string;
  home: string;
  model: DaimonGrokBrokerModel;
  profile: string;
  profilePath: string;
  profileSha256: string;
  reasoningEffort: DaimonGrokBrokerReasoningEffort;
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
 * One brokered worker's sandbox deny list.
 *
 * Daimon's own protected set for the agent (`grokSandboxProtectedPaths`: the
 * Grok bootstrap and realm, the AGY realm and unlock secret when any agent is
 * AGY, the wake-acceptance store, and every peer's runtime home and workspace)
 * plus what this deployment adds: the broker's registration/service directory
 * and control/relay socket directory, the usage-ledger and wake-fuse volumes,
 * every other worker's home, and the container secret roots. Grok 1.0.34's
 * strict base reads all of `/run`, `/var`, `/tmp` and `/etc`, and bind mounts
 * from a macOS host ignore unix modes, so this list — not file modes — is the
 * boundary. Entries must never nest: one mask inside another cannot be applied.
 */
export const resolveDaimonGrokWorkerDenyPaths = (
  plan: RuntimeTargetPlan,
  agentId: string,
  workerHomes: readonly string[],
  ownHome: string
): string[] => {
  const instanceRoot = plan.instancePaths.instanceRoot ?? fail("Daimon Grok registrations require an instance root");
  const agents = Object.entries(plan.engineByNodeId ?? {});
  const peers = agents.filter(([id]) => id !== agentId).map(([id]) => nodeSlug(id));
  const denied = [...new Set([
    DAIMON_GROK_SUBSCRIPTION_REALM.bootstrapMountPath,
    DAIMON_GROK_SUBSCRIPTION_REALM.durableMountPath,
    ...(agents.some(([, engine]) => engine === "agy") ? [DAIMON_AGY_SUBSCRIPTION_REALM.unlockMountPath, DAIMON_AGY_SUBSCRIPTION_REALM.durableMountPath] : []),
    path.posix.join(instanceRoot, DAIMON_RUNTIME_ACCEPTANCE_STORE_DIRECTORY),
    ...peers.flatMap((slug) => [
      path.posix.join(instanceRoot, DAIMON_RUNTIME_HOMES_DIRECTORY, slug),
      path.posix.join(plan.instancePaths.workspacePath, "agents", slug)
    ]),
    path.posix.dirname(DAIMON_GROK_ENGINE_BROKER.registrationPath),
    path.posix.dirname(DAIMON_GROK_ENGINE_BROKER.controlSocketPath),
    DAIMON_GROK_TURN_USAGE_LEDGER.directoryPath,
    DAIMON_WAKE_FUSE_DIRECTORY,
    ...workerHomes.filter((home) => home !== ownHome),
    ...DAIMON_GROK_OPTIONAL_DENY_PATHS
  ])].sort();
  for (const entry of denied) {
    const ancestor = denied.find((other) => other !== entry && entry.startsWith(`${other}/`));
    if (ancestor) fail(`Grok worker deny path ${entry} nests inside ${ancestor}`);
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
    const home = homes[slot]!;
    const grokHome = path.posix.join(home, DAIMON_GROK_WORKER_HOME_DIRECTORY);
    const { model, reasoningEffort } = declaredModel(plan, agentId);
    const config = resolveDaimonGrokWorkerConfig(model, reasoningEffort);
    const denyPaths = resolveDaimonGrokWorkerDenyPaths(plan, agentId, homes, home);
    const profile = renderDaimonGrokWorkerSandboxProfile(denyPaths);
    return {
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
      reasoningEffort,
      slot,
      uid: DAIMON_FIRST_WORKER_UID + slot,
      // Production keeps one container ledger: `spawnfile usage` and Daimon's
      // wake fuse both read it, so a per-slot file would hide Grok spend from both.
      usageLedgerPath: DAIMON_GROK_TURN_USAGE_LEDGER.filePath,
      workspace: path.posix.join(plan.instancePaths.workspacePath, "agents", nodeSlug(agentId))
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
