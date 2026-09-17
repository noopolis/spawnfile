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

/**
 * Private temp for the broker and its relay (uid 2100, outside the organization
 * group), deliberately **outside** `/run/daimon-engine-broker`.
 *
 * Production puts it at `<control root>/tmp`, which is fine there: that root is
 * removed and recreated exactly once, at container start. Training
 * re-provisions the same root on every recycle, and the launch mounts this
 * directory as its own tmpfs — so a `tmp/` inside the cleared root is a *mount
 * point*, and clearing a mount point fails `EBUSY`. A live P8 launch died
 * exactly there. Its own tmpfs under `/run/training` is never a wipe target and
 * is denied to every worker uid.
 */
export const TRAINING_BROKER_TMPDIR = "/run/training/broker-tmp";

export const TRAINING_SUPERVISOR_DIRECTORY = "/run/training/supervisor";
export const TRAINING_SUPERVISOR_SOCKET = `${TRAINING_SUPERVISOR_DIRECTORY}/control.sock`;
export const TRAINING_SUPERVISOR_LOG = `${TRAINING_SUPERVISOR_DIRECTORY}/supervisor.log`;

export const TRAINING_WORKER_ROOT = DAIMON_WORKER_ROOT;
export const TRAINING_SLOT_INDEX = 0;
export const TRAINING_WORKER_UID = DAIMON_FIRST_WORKER_UID + TRAINING_SLOT_INDEX;
export const TRAINING_WORKER_HOME = path.posix.join(TRAINING_WORKER_ROOT, String(TRAINING_WORKER_UID));

/**
 * Paideia's own fixed container paths (`containerPaths` in its native launch
 * schema). They are *not* individual deny entries: Grok 1.0.34 materializes
 * every `deny` target inside bubblewrap as the worker uid, and it cannot
 * create a file inside `/run/paideia`, which belongs to uid 2000 alone. The
 * single `/run/paideia` mask below covers all of them, which is also stronger
 * — a file Paideia adds later is covered without re-provisioning the slot.
 */
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
  { role: "context", path: TRAINING_PAIDEIA_ROOT },
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
  TRAINING_BROKER_TMPDIR,
  path.posix.dirname(DAIMON_GROK_ENGINE_BROKER.controlSocketPath),
  path.posix.dirname(DAIMON_GROK_ENGINE_BROKER.registrationPath),
  DAIMON_GROK_TURN_USAGE_LEDGER.directoryPath,
  DAIMON_WAKE_FUSE_DIRECTORY,
  TRAINING_INFERENCE_DIRECTORY,
  // `TRAINING_SLOT_STATE_ROOT` is Daimon's own protected entry here (it covers the
  // wake-acceptance store, which is itself unplaceable under a `2000:2000 0700`
  // parent), so it is not repeated in this set.
  TRAINING_SLOT_TURN_STORE,
  TRAINING_SUPERVISOR_DIRECTORY,
  ...TRAINING_EVALUATOR_ROOTS.map((entry) => entry.path)
];

/** Paths the provisioning program creates root-owned `0700` when absent, so every deny entry always has a target inode. */
export const TRAINING_OPTIONAL_DENY_DIRECTORIES: readonly string[] = [
  TRAINING_BROKER_TMPDIR,
  TRAINING_INFERENCE_DIRECTORY,
  TRAINING_SLOT_STATE_ROOT,
  TRAINING_SLOT_TURN_STORE,
  TRAINING_SUPERVISOR_DIRECTORY,
  TRAINING_GRANT_HOME_ROOT,
  // Denied and unused here — training meters per slot — but the mask still needs an inode. The launch
  // mounts each as tmpfs, so this only creates them when a caller ran the entrypoint without them.
  DAIMON_GROK_TURN_USAGE_LEDGER.directoryPath,
  DAIMON_WAKE_FUSE_DIRECTORY
];

/**
 * Deny entries a launch may legitimately not have mounted. Everything else must
 * exist before a worker turn: Grok 1.0.34 creates an absent `deny` target as
 * the worker uid inside bubblewrap and refuses the whole profile when it
 * cannot, so provisioning materializes every other entry itself.
 */
export const TRAINING_DEFERRED_DENY_PATHS: readonly string[] = [
  // Docker materializes both host binds before the entrypoint runs. They sit on the read-only image
  // root, which root cannot create into, so provisioning must tolerate a launch that declared neither.
  TRAINING_RUN_ROOT,
  TRAINING_SEALED_INPUTS_ROOT
];

/**
 * Deny entries that are host bind mounts.
 *
 * A worker-uid read probe over one of these proves nothing: the host owns the
 * inode, its mode is whatever the operator's project directory happens to be,
 * and Docker Desktop and Colima ignore `chown` outright (P0 §5). Their boundary
 * is the bubblewrap-enforced `deny` list, which P0 verified blocks both shell
 * `cat` and `read_file` on 1.0.34. The declaration's `unenforcedBindPolicy`
 * decides whether the slot supervisor accepts that or refuses the slot.
 */
export const TRAINING_HOST_BIND_DENY_PATHS: readonly string[] = [TRAINING_RUN_ROOT, TRAINING_SEALED_INPUTS_ROOT];

export const TRAINING_REALM_MOUNT = DAIMON_GROK_SUBSCRIPTION_REALM.durableMountPath;
export const TRAINING_BOOTSTRAP_MOUNT = DAIMON_GROK_SUBSCRIPTION_REALM.bootstrapMountPath;
export { DAIMON_BROKER_UID, DAIMON_ORGANIZATION_UID };
