import path from "node:path";

import { SpawnfileError } from "../../../shared/index.js";
import {
  DAIMON_GROK_BROKER_MODELS,
  DAIMON_GROK_BROKER_REASONING_EFFORTS,
  DAIMON_GROK_ENGINE_BROKER,
  type DaimonGrokBrokerModel,
  type DaimonGrokBrokerReasoningEffort
} from "../../../runtime/daimon/contractManifest.js";
import {
  DAIMON_GROK_WORKER_HOME_DIRECTORY,
  daimonGrokWorkerSandboxProfileSha256,
  renderDaimonGrokWorkerSandboxProfile,
  resolveDaimonGrokWorkerConfig
} from "../../../runtime/daimon/grokWorkerContract.js";
import {
  DAIMON_GROK_BASE_PROFILE_GRANTS,
  assertCanonicalRegisteredPath,
  type DaimonGrokRegistration
} from "../../containerDaimonGrokWorkerRender.js";
import {
  TRAINING_ADDED_DENY_PATHS,
  TRAINING_BOOTSTRAP_MOUNT,
  TRAINING_DEFERRED_DENY_PATHS,
  TRAINING_REALM_MOUNT,
  TRAINING_SLOT_INDEX,
  TRAINING_SLOT_RUNTIME_HOME,
  TRAINING_SLOT_STATE_ROOT,
  TRAINING_SLOT_USAGE_LEDGER,
  TRAINING_SLOT_WORKSPACE,
  TRAINING_WORKER_HOME,
  TRAINING_WORKER_UID
} from "./paths.js";

const fail = (message: string): never => {
  throw new SpawnfileError("compile_error", message);
};

const within = (candidate: string, root: string): boolean => candidate === root || candidate.startsWith(`${root}/`);

/**
 * The one training slot's deny list: Daimon's own protected set for a
 * single-agent organization (Grok bootstrap, realm, and the slot state root that
 * holds the wake-acceptance store) plus everything this container provisions that the subject must not read —
 * the evaluator roots, the caller's protected `/run/paideia` paths, the broker
 * control and registration roots, the grant home root, the inference ledger,
 * the per-slot ledger, turn store and supervisor socket directory.
 *
 * The same two refusals the production render enforces apply here: an entry
 * that equals or contains a Grok 1.0.34 base-profile grant makes Grok refuse
 * the profile outright, and masks cannot nest, so an entry covered by another
 * entry is a provisioning bug rather than something to silently drop.
 */
export const resolveTrainingGrokDenyPaths = (added: readonly string[] = TRAINING_ADDED_DENY_PATHS): string[] => {
  // The wake-acceptance store is masked through `TRAINING_SLOT_STATE_ROOT`, never directly: Grok 1.0.34
  // materializes every deny target inside bubblewrap AS THE WORKER UID, and the store's parent is
  // `2000:2000 0700`, so the store itself is unplaceable and would make Grok refuse the whole profile
  // (`.runtime/grok-deny-placement/EVIDENCE.md`). The state root covers it and nothing else lives there.
  const daimonOwn = [TRAINING_BOOTSTRAP_MOUNT, TRAINING_REALM_MOUNT, TRAINING_SLOT_STATE_ROOT];
  const grokHome = path.posix.join(TRAINING_WORKER_HOME, DAIMON_GROK_WORKER_HOME_DIRECTORY);
  const grants = [
    ...DAIMON_GROK_BASE_PROFILE_GRANTS, TRAINING_SLOT_WORKSPACE, grokHome,
    path.posix.join(grokHome, "sessions"), path.posix.join(TRAINING_WORKER_HOME, "tmp")
  ];
  const candidates = [...new Set([...daimonOwn, ...added])].sort();
  for (const entry of candidates) {
    assertCanonicalRegisteredPath("deny path", entry);
    const grant = grants.find((candidate) => within(candidate, entry));
    if (grant) fail(`Training Grok deny path ${entry} equals or contains the base profile grant ${grant}; Grok refuses such a profile`);
    if (within(TRAINING_SLOT_WORKSPACE, entry) || within(TRAINING_WORKER_HOME, entry) || within(TRAINING_SLOT_RUNTIME_HOME, entry)) {
      fail(`Training Grok deny path ${entry} would hide the subject's own workspace, home, or runtime home`);
    }
    const ancestor = candidates.find((other) => other !== entry && within(entry, other));
    if (ancestor) fail(`Training Grok deny path ${ancestor} would cover ${entry}; masks cannot nest`);
  }
  return candidates;
};

export interface TrainingGrokSlotInput {
  agentId: string;
  model: DaimonGrokBrokerModel;
  reasoningEffort: DaimonGrokBrokerReasoningEffort;
  /** Deny entries this container adds beyond Daimon's own protected set; defaults to the fixed training set. */
  denyPaths?: readonly string[];
}

/**
 * The single brokered Grok registration a training container runs, at the
 * fixed container paths in `paths.ts`. Unlike production it points
 * `usageLedgerPath` at the per-slot ledger, because each trial's spend must be
 * separable and a recycle wipes it; the container-wide ledger and wake fuse do
 * not exist here.
 */
export const resolveTrainingGrokRegistration = (input: TrainingGrokSlotInput): DaimonGrokRegistration => {
  if (!input.agentId.trim()) fail("Training Grok slot requires an agent id");
  if (!(DAIMON_GROK_BROKER_MODELS as readonly string[]).includes(input.model)
    || !(DAIMON_GROK_BROKER_REASONING_EFFORTS as readonly string[]).includes(input.reasoningEffort)) {
    fail(`Training Grok slot has no declared broker model and reasoning effort: ${input.agentId}`);
  }
  const home = assertCanonicalRegisteredPath("home", TRAINING_WORKER_HOME);
  const grokHome = path.posix.join(home, DAIMON_GROK_WORKER_HOME_DIRECTORY);
  const config = resolveDaimonGrokWorkerConfig(input.model, input.reasoningEffort);
  const denyPaths = resolveTrainingGrokDenyPaths(input.denyPaths);
  const profile = renderDaimonGrokWorkerSandboxProfile(denyPaths);
  const eventsPath = path.posix.join(grokHome, DAIMON_GROK_ENGINE_BROKER.worker.home.sandboxEvents.relativePath);
  const profilePath = path.posix.join(grokHome, "sandbox.toml");
  for (const [label, value] of [["GROK_HOME", grokHome], ["profile", profilePath], ["events", eventsPath],
    ["workspace", TRAINING_SLOT_WORKSPACE], ["runtime home", TRAINING_SLOT_RUNTIME_HOME],
    ["usage ledger", TRAINING_SLOT_USAGE_LEDGER]] as const) assertCanonicalRegisteredPath(label, value);
  return {
    agentId: input.agentId,
    config: config.bytes,
    configSha256: config.sha256,
    deferredDenyPaths: denyPaths.filter((entry) => TRAINING_DEFERRED_DENY_PATHS.includes(entry)),
    denyPaths,
    eventsPath,
    grokHome,
    home,
    model: input.model,
    profile,
    profilePath,
    profileSha256: daimonGrokWorkerSandboxProfileSha256(denyPaths),
    privateTmp: path.posix.join(home, DAIMON_GROK_ENGINE_BROKER.worker.home.privateTmp.relativeToWorkerHome),
    reasoningEffort: input.reasoningEffort,
    runtimeHome: TRAINING_SLOT_RUNTIME_HOME,
    slot: TRAINING_SLOT_INDEX,
    spillDirectory: path.posix.join(TRAINING_SLOT_RUNTIME_HOME, DAIMON_GROK_ENGINE_BROKER.worker.home.spillDirectory.relativeToRuntimeHome),
    uid: TRAINING_WORKER_UID,
    usageLedgerPath: TRAINING_SLOT_USAGE_LEDGER,
    workspace: TRAINING_SLOT_WORKSPACE
  };
};
