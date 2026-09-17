import path from "node:path";

import {
  DAIMON_GROK_ENGINE_BROKER,
  DAIMON_GROK_SUBSCRIPTION_REALM,
  DAIMON_GROK_TURN_USAGE_LEDGER
} from "../../../runtime/daimon/contractManifest.js";
import {
  DAIMON_BROKER_UID,
  DAIMON_FIRST_WORKER_UID,
  DAIMON_ORGANIZATION_UID
} from "../../../runtime/daimon/runtimeIdentity.js";
import { DAIMON_WAKE_FUSE_DIRECTORY } from "../../../runtime/daimon/config.js";
import { DAIMON_WORKER_ROOT } from "../../containerDaimonGrokWorkerRender.js";

/**
 * Every container path the broker-capable training container fixes.
 *
 * They are fixed rather than derived because three parties must agree on them
 * without talking to each other: the root entrypoint that provisions them, the
 * root slot supervisor that wipes and re-provisions them on recycle, and
 * Paideia's native adapter, which writes them into `paideia.daimon-native.launch.v2`
 * and has no way to ask the container what it chose. Daimon's projection never
 * resolves a path, so each one must also be canonical and never a symlink; the
 * provisioning program asserts that before a slot is used.
 *
 * Everything under `/run/training/slot` is per-trial state on tmpfs — never the
 * Grok realm volume (R2). The realm volume holds only `auth.json` and the
 * broker credential journal, so a recycle can wipe the slot without touching
 * the one durable rotating credential.
 */
export const TRAINING_RUN_ROOT = "/run/training/output";
export const TRAINING_SEALED_INPUTS_ROOT = "/run/training/inputs";
export const TRAINING_PAIDEIA_ROOT = "/run/paideia";
export const TRAINING_CONTEXT_FILE = `${TRAINING_PAIDEIA_ROOT}/context.json`;
/** Host-written, read-only `spawnfile.training-broker.v1` declaration the root entrypoint reads. */
export const TRAINING_BROKER_DECLARATION_FILE = `${TRAINING_PAIDEIA_ROOT}/training-broker.json`;

export const TRAINING_SLOT_ROOT = "/run/training/slot";
export const TRAINING_SLOT_WORKSPACE = `${TRAINING_SLOT_ROOT}/workspace`;
export const TRAINING_SLOT_RUNTIME_HOME = `${TRAINING_SLOT_ROOT}/runtime-home`;
export const TRAINING_SLOT_STATE_ROOT = `${TRAINING_SLOT_ROOT}/state`;
export const TRAINING_SLOT_ACCEPTANCE_STORE = `${TRAINING_SLOT_STATE_ROOT}/wake-acceptance`;
/** Per-slot turn store. On tmpfs on purpose: a replayed turn from trial N must never satisfy trial N+1 (R2). */
export const TRAINING_SLOT_TURN_STORE = `${TRAINING_SLOT_ROOT}/turns`;
export const TRAINING_SLOT_USAGE_DIRECTORY = `${TRAINING_SLOT_ROOT}/usage`;
export const TRAINING_SLOT_USAGE_LEDGER = `${TRAINING_SLOT_USAGE_DIRECTORY}/usage.jsonl`;
export const TRAINING_SLOT_PREFLIGHT_RECEIPT = `${TRAINING_SLOT_ROOT}/preflight.json`;
/** Supervisor-owned monotonic generation counter; survives a recycle, never a container restart. */
export const TRAINING_SLOT_GENERATION_FILE = `${TRAINING_SLOT_ROOT}/generation.json`;

export const TRAINING_INFERENCE_DIRECTORY = "/run/training/inference";
export const TRAINING_INFERENCE_LEDGER = `${TRAINING_INFERENCE_DIRECTORY}/inference.jsonl`;
/** Judge grant homes: `2000:2000 0700`, denied to every worker uid. Paideia reads it as `PAIDEIA_GROK_GRANT_HOME_ROOT`. */
export const TRAINING_GRANT_HOME_ROOT = "/run/training/grants";

export const TRAINING_SUPERVISOR_DIRECTORY = "/run/training/supervisor";
export const TRAINING_SUPERVISOR_SOCKET = `${TRAINING_SUPERVISOR_DIRECTORY}/control.sock`;
export const TRAINING_SUPERVISOR_LOG = `${TRAINING_SUPERVISOR_DIRECTORY}/supervisor.log`;

export const TRAINING_WORKER_ROOT = DAIMON_WORKER_ROOT;
export const TRAINING_SLOT_INDEX = 0;
export const TRAINING_WORKER_UID = DAIMON_FIRST_WORKER_UID + TRAINING_SLOT_INDEX;
export const TRAINING_WORKER_HOME = path.posix.join(TRAINING_WORKER_ROOT, String(TRAINING_WORKER_UID));

/** Paideia's own fixed container paths (`containerPaths` in its native launch schema); all protected from the worker. */
export const TRAINING_CALLER_PROTECTED_PATHS = [
  `${TRAINING_PAIDEIA_ROOT}/config.json`,
  `${TRAINING_PAIDEIA_ROOT}/control`,
  `${TRAINING_PAIDEIA_ROOT}/launch.json`,
  `${TRAINING_PAIDEIA_ROOT}/token`,
  `${TRAINING_PAIDEIA_ROOT}/env`,
  `${TRAINING_PAIDEIA_ROOT}/preparation.json`,
  `${TRAINING_PAIDEIA_ROOT}/repair.json`
] as const;

/** `paideia.daimon-native.launch.v2`'s five `broker.evaluatorPaths` roles, at this container's real paths. */
export const TRAINING_EVALUATOR_ROOTS = [
  { role: "run-root", path: TRAINING_RUN_ROOT },
  { role: "context", path: TRAINING_CONTEXT_FILE },
  { role: "sealed-inputs", path: TRAINING_SEALED_INPUTS_ROOT },
  { role: "judge-home", path: TRAINING_GRANT_HOME_ROOT },
  { role: "slot-ledger", path: TRAINING_SLOT_USAGE_DIRECTORY }
] as const;

/**
 * Everything this container provisions that the one training worker must not
 * read, beyond Daimon's own protected set (realm, bootstrap, acceptance store).
 * Each entry sits strictly below a Grok 1.0.34 base-profile grant — Grok
 * refuses a profile whose deny entry equals or contains `/run`, `/var`, `/etc`
 * or `/tmp` — and no entry covers another, because masks cannot nest.
 */
export const TRAINING_ADDED_DENY_PATHS: readonly string[] = [
  path.posix.dirname(DAIMON_GROK_ENGINE_BROKER.controlSocketPath),
  path.posix.dirname(DAIMON_GROK_ENGINE_BROKER.registrationPath),
  DAIMON_GROK_TURN_USAGE_LEDGER.directoryPath,
  DAIMON_WAKE_FUSE_DIRECTORY,
  TRAINING_BROKER_DECLARATION_FILE,
  TRAINING_INFERENCE_DIRECTORY,
  TRAINING_SLOT_STATE_ROOT,
  TRAINING_SLOT_TURN_STORE,
  TRAINING_SUPERVISOR_DIRECTORY,
  ...TRAINING_CALLER_PROTECTED_PATHS,
  ...TRAINING_EVALUATOR_ROOTS.map((entry) => entry.path)
];

/** Paths the provisioning program creates root-owned `0700` when absent, so every deny entry always has a target inode. */
export const TRAINING_OPTIONAL_DENY_DIRECTORIES: readonly string[] = [
  TRAINING_INFERENCE_DIRECTORY,
  TRAINING_SLOT_STATE_ROOT,
  TRAINING_SLOT_TURN_STORE,
  TRAINING_SUPERVISOR_DIRECTORY,
  TRAINING_RUN_ROOT,
  TRAINING_SEALED_INPUTS_ROOT,
  TRAINING_GRANT_HOME_ROOT
];

/**
 * Deny entries Paideia materializes per trial inside its own `/run/paideia`
 * tmpfs. Absent is allowed at provisioning time (the profile still masks the
 * path once it exists, because Grok applies the profile at every worker spawn);
 * a symlink never is.
 */
export const TRAINING_DEFERRED_DENY_PATHS: readonly string[] = [...TRAINING_CALLER_PROTECTED_PATHS];

export const TRAINING_REALM_MOUNT = DAIMON_GROK_SUBSCRIPTION_REALM.durableMountPath;
export const TRAINING_BOOTSTRAP_MOUNT = DAIMON_GROK_SUBSCRIPTION_REALM.bootstrapMountPath;
export { DAIMON_BROKER_UID, DAIMON_ORGANIZATION_UID };
