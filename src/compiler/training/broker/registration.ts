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
  resolveDaimonGrokClockedWorkerConfig
} from "../../../runtime/daimon/grokWorkerContract.js";
import { resolveDaimonGrokWorkerSkills, type DaimonAgentSkill } from "../../../runtime/daimon/grokWorkerSkills.js";
import {
  DAIMON_GROK_BASE_PROFILE_GRANTS,
  assertCanonicalRegisteredPath,
  type DaimonGrokRegistration
} from "../../containerDaimonGrokWorkerRender.js";
import { trainingSlotPaths, trainingEvaluatorPaths, TRAINING_BOOTSTRAP_MOUNT, TRAINING_REALM_MOUNT, TRAINING_DEFERRED_DENY_PATHS } from "./paths.js";

const fail = (message: string): never => {
  throw new SpawnfileError("compile_error", message);
};

const within = (candidate: string, root: string): boolean => candidate === root || candidate.startsWith(`${root}/`);

/**
 * The one training slot's deny list: Daimon's own protected set for a
 * single-agent organization (Grok bootstrap, realm, and the slot state root that
 * holds the wake-acceptance store) plus everything this container provisions that the subject must not read —
 * the evaluator roots, the caller's protected `/run/spawnfile-training` paths, the broker
 * control and registration roots, the grant home root, the inference ledger,
 * the per-slot ledger, turn store and supervisor socket directory.
 *
 * The same two refusals the production render enforces apply here: an entry
 * that equals or contains a Grok 1.0.34 base-profile grant makes Grok refuse
 * the profile outright, and masks cannot nest, so an entry covered by another
 * entry is a provisioning bug rather than something to silently drop.
 */
export const resolveTrainingGrokDenyPaths = (added: readonly string[] | undefined = undefined, slot = 0, slots = 1): string[] => {
  const p = trainingSlotPaths(slot);
  const required = trainingEvaluatorPaths(slot, slots).map(entry => entry.path);
  // The wake-acceptance store is masked through `p.state`, never directly: Grok 1.0.34
  // materializes every deny target inside bubblewrap AS THE WORKER UID, and the store's parent is
  // `2000:2000 0700`, so the store itself is unplaceable and would make Grok refuse the whole profile
  // (`.runtime/grok-deny-placement/EVIDENCE.md`). The state root covers it and nothing else lives there.
  const daimonOwn = [TRAINING_BOOTSTRAP_MOUNT, TRAINING_REALM_MOUNT, p.state];
  const grokHome = path.posix.join(p.workerHome, DAIMON_GROK_WORKER_HOME_DIRECTORY);
  const grants = [
    ...DAIMON_GROK_BASE_PROFILE_GRANTS, p.workspace, grokHome,
    path.posix.join(grokHome, "sessions"), path.posix.join(p.workerHome, "tmp")
  ];
  const candidates = [...new Set([...daimonOwn, ...required, ...(added ?? [])])].sort();
  for (const entry of candidates) {
    assertCanonicalRegisteredPath("deny path", entry);
    const grant = grants.find((candidate) => within(candidate, entry));
    if (grant) fail(`Training Grok deny path ${entry} equals or contains the base profile grant ${grant}; Grok refuses such a profile`);
    if (within(p.workspace, entry) || within(p.workerHome, entry) || within(p.runtimeHome, entry)) {
      fail(`Training Grok deny path ${entry} would hide the subject's own workspace, home, or runtime home`);
    }
    if ([p.clockFile, DAIMON_GROK_ENGINE_BROKER.worker.taskClock.preloadPath,
      "/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1", "/usr/lib/aarch64-linux-gnu/faketime/libfaketime.so.1"].some(file => within(file, entry))) {
      fail(`Training Grok deny path ${entry} would hide the subject's task clock`);
    }
    const ancestor = candidates.find((other) => other !== entry && within(entry, other));
    if (ancestor) fail(`Training Grok deny path ${ancestor} would cover ${entry}; masks cannot nest`);
  }
  return candidates;
};

export interface TrainingGrokSlotInput {
  slot?: number;
  slots?: number;
  agentId: string;
  model: DaimonGrokBrokerModel;
  reasoningEffort: DaimonGrokBrokerReasoningEffort;
  /** Deny entries this container adds beyond Daimon's own protected set; defaults to the fixed training set. */
  denyPaths?: readonly string[];
  /**
   * The declaration's per-turn limits. The broker registration must declare
   * them, because a wake may only LOWER a declared limit: a trial whose wake
   * ceiling exceeds the manifest defaults is refused as `invalid_request`.
   */
  limits?: { maxRequests: number; maxTokens: number; timeoutMs: number };
  /** The declaration's skills; rendered into the slot's `$GROK_HOME/skills` and bound as `skillsSha256`. */
  skills?: readonly DaimonAgentSkill[];
}

/**
 * The single brokered Grok registration a training container runs, at the
 * fixed container paths in `paths.ts`. Unlike production it points
 * `usageLedgerPath` at the per-slot ledger, because each trial's spend must be
 * separable and a recycle wipes it; the container-wide ledger and wake fuse do
 * not exist here.
 */
export const resolveTrainingGrokRegistration = (input: TrainingGrokSlotInput): DaimonGrokRegistration => {
  const p = trainingSlotPaths(input.slot ?? 0);
  if (!input.agentId.trim()) fail("Training Grok slot requires an agent id");
  if (!(DAIMON_GROK_BROKER_MODELS as readonly string[]).includes(input.model)
    || !(DAIMON_GROK_BROKER_REASONING_EFFORTS as readonly string[]).includes(input.reasoningEffort)) {
    fail(`Training Grok slot has no declared broker model and reasoning effort: ${input.agentId}`);
  }
  const home = assertCanonicalRegisteredPath("home", p.workerHome);
  const grokHome = path.posix.join(home, DAIMON_GROK_WORKER_HOME_DIRECTORY);
  const config = resolveDaimonGrokClockedWorkerConfig(input.model, input.reasoningEffort, p.slot);
  const denyPaths = resolveTrainingGrokDenyPaths(input.denyPaths, p.slot, input.slots ?? 1);
  const profile = renderDaimonGrokWorkerSandboxProfile(denyPaths);
  const eventsPath = path.posix.join(grokHome, DAIMON_GROK_ENGINE_BROKER.worker.home.sandboxEvents.relativePath);
  const profilePath = path.posix.join(grokHome, "sandbox.toml");
  for (const [label, value] of [["GROK_HOME", grokHome], ["profile", profilePath], ["events", eventsPath],
    ["workspace", p.workspace], ["runtime home", p.runtimeHome],
    ["usage ledger", p.usageLedger]] as const) assertCanonicalRegisteredPath(label, value);
  const skills = resolveDaimonGrokWorkerSkills(input.skills);
  return {
    ...(skills ? { skills } : {}),
    agentId: input.agentId,
    config: config.bytes,
    configVariant: "clocked",
    ...(input.limits === undefined ? {} : { limits: { ...input.limits } }),
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
    runtimeHome: p.runtimeHome,
    // Empty on purpose: training has no persistent mounts at all. Everything a trial writes under the slot
    // runtime home is per-slot tmpfs the recycle wipes, and the only thing provisioned inside it is the
    // setgid `tool-output/` spill directory, so the traversable `0710` home exposes nothing else.
    runtimeHomeMounts: [],
    slot: p.slot,
    spillDirectory: path.posix.join(p.runtimeHome, DAIMON_GROK_ENGINE_BROKER.worker.home.spillDirectory.relativeToRuntimeHome),
    uid: p.workerUid,
    usageLedgerPath: p.usageLedger,
    workspace: p.workspace
  };
};
