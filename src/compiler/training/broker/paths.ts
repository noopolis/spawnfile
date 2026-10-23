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
 * They are deterministic because three parties must agree on them
 * without talking to each other: the root entrypoint that provisions them, the
 * root slot supervisor that wipes and re-provisions them on recycle, and
 * Spawnfile's native training adapter, which writes them into `spawnfile.training.daimon-native.launch.v2`
 * and has no way to ask the container what it chose. Daimon's projection never
 * resolves a path, so each one must also be canonical and never a symlink; the
 * provisioning program asserts that before a slot is used.
 *
 * Everything under `/run/training/slots/<i>` is per-trial state on tmpfs — never the
 * Grok realm volume (R2). The realm volume holds only `auth.json` and the
 * broker credential journal, so a recycle can wipe the slot without touching
 * the one durable rotating credential.
 */
export const TRAINING_RUN_ROOT = "/run/training/output";
export const TRAINING_SEALED_INPUTS_ROOT = "/run/training/inputs";
export const TRAINING_ROOT = "/run/spawnfile-training";
export const TRAINING_CONTEXT_FILE = `${TRAINING_ROOT}/context.json`;
/** Host-written, read-only `spawnfile.training-broker.v2` declaration the root entrypoint reads. */
export const TRAINING_BROKER_DECLARATION_FILE = `${TRAINING_ROOT}/training-broker.json`;

export const TRAINING_INFERENCE_DIRECTORY = "/run/training/inference";
export const TRAINING_INFERENCE_LEDGER = `${TRAINING_INFERENCE_DIRECTORY}/inference.jsonl`;
/** Judge grant homes: `2000:2000 0700`, denied to every worker uid. Training reads it as `SPAWNFILE_TRAINING_GROK_GRANT_HOME_ROOT`. */
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
/**
 * Training's own fixed container paths (`containerPaths` in its native launch
 * schema). They are *not* individual deny entries: Grok 1.0.34 materializes
 * every `deny` target inside bubblewrap as the worker uid, and it cannot
 * create a file inside `/run/spawnfile-training`, which belongs to uid 2000 alone. The
 * single `/run/spawnfile-training` mask below covers all of them, which is also stronger
 * — a file Training adds later is covered without re-provisioning the slot.
 */
export const TRAINING_CALLER_PROTECTED_PATHS = [
  `${TRAINING_ROOT}/config.json`,
  `${TRAINING_ROOT}/control`,
  `${TRAINING_ROOT}/launch.json`,
  `${TRAINING_ROOT}/token`,
  `${TRAINING_ROOT}/env`,
  `${TRAINING_ROOT}/preparation.json`,
  `${TRAINING_ROOT}/repair.json`
] as const;

/**
 * `spawnfile.training.daimon-native.launch.v2`'s `broker.evaluatorPaths`, in full.
 *
 * This is not a summary of the five roles — it is the **whole** set of deny
 * entries this container adds beyond Daimon's own protected paths, because
 * Training's worker resolves the projection from exactly
 * `[...new Set(broker.evaluatorPaths.map(row => row.path))].sort()`. A launch
 * that carried only the five roles made Daimon hash a different deny list than
 * the one provisioning wrote, and a live run died on
 * `Grok broker projection digest differs from the launch receipt`.
 *
 * `role` is Training's closed five-value enum and may repeat; only `path` is
 * unique. The four roles with a dedicated path keep it, and everything else is
 * tagged `context` — the caller-state role — since there is no other way to
 * carry a path through that contract.
 */
export const TRAINING_SLOTS_FILE = `${TRAINING_ROOT}/slots.json`;
export const TRAINING_SLOTS_VERSION = "spawnfile.training-slots.v1" as const;
export const TRAINING_DEFAULT_SLOTS = 4;
export const TRAINING_MAX_SLOTS = 8;
/** 100 ports per slot: offsets 0=Moltnet, 1=worker control, 2=bridge; 3..99 reserved. */
export const TRAINING_PORT_BASE = 20_000;
export const TRAINING_PORT_STRIDE = 100;
export const TRAINING_BROKER_SOCKET_PATHS = [
  DAIMON_GROK_ENGINE_BROKER.controlSocketPath, DAIMON_GROK_ENGINE_BROKER.backendSocketPath,
  DAIMON_GROK_ENGINE_BROKER.launcherSocketPath
] as const;
export const TRAINING_TURN_STORE_ROOT = "/run/training/turns";
/** Persistent, broker-only run counter; never part of a slot recycle. */
export const TRAINING_RUN_REQUEST_STORE = "/run/training/request-budget";

export const assertTrainingSlotCount = (slots: number): number => {
  if (!Number.isInteger(slots) || slots < 1 || slots > TRAINING_MAX_SLOTS) throw Error("Training slots must be an integer from 1 to 8");
  return slots;
};
export const trainingSlotPaths = (slot: number) => {
  if (!Number.isInteger(slot) || slot < 0 || slot >= TRAINING_MAX_SLOTS) throw Error("Training slot index must be an integer from 0 to 7");
  const root = `/run/training/slots/${slot}`;
  const workerUid = DAIMON_FIRST_WORKER_UID + slot;
  const workerHome = `${TRAINING_WORKER_ROOT}/${workerUid}`;
  const portBase = TRAINING_PORT_BASE + slot * TRAINING_PORT_STRIDE;
  const clockDirectory = `/run/daimon-engine-broker/task-clock/slot-${slot}`;
  return {
    slot, workerUid, root, workerHome, workspace: `${root}/workspace`, runtimeHome: `${root}/runtime-home`,
    state: `${root}/state`, acceptanceStore: `${root}/state/wake-acceptance`,
    turns: `${TRAINING_TURN_STORE_ROOT}/slot-${slot}`, usageDirectory: `${root}/usage`, usageLedger: `${root}/usage/usage.jsonl`,
    preflightReceipt: `${root}/preflight.json`, generationFile: `${root}/generation.json`,
    sealedInputsAttestation: `${root}/sealed-inputs.json`, privateTmp: `${workerHome}/tmp`,
    clockDirectory, clockFile: `${clockDirectory}/faketime`,
    ports: { base: portBase, stride: TRAINING_PORT_STRIDE, moltnet: portBase, workerControl: portBase + 1, bridge: portBase + 2 }
  };
};
export type TrainingSlotPaths = ReturnType<typeof trainingSlotPaths>;
export type TrainingEvaluatorPath = { role: "run-root" | "context" | "sealed-inputs" | "judge-home" | "slot-ledger"; path: string };

/** The complete additional projection deny set. Sibling roots and homes never nest with own masks. */
export const trainingEvaluatorPaths = (slot: number, slots: number): TrainingEvaluatorPath[] => {
  assertTrainingSlotCount(slots);
  if (slot >= slots) throw Error("Training slot is outside the declared pool");
  const own = trainingSlotPaths(slot);
  return [
    { role: "run-root", path: TRAINING_RUN_ROOT },
    { role: "sealed-inputs", path: TRAINING_SEALED_INPUTS_ROOT },
    { role: "judge-home", path: TRAINING_GRANT_HOME_ROOT },
    { role: "slot-ledger", path: own.usageDirectory },
    ...[TRAINING_ROOT, TRAINING_BROKER_TMPDIR, TRAINING_INFERENCE_DIRECTORY,
      TRAINING_TURN_STORE_ROOT, TRAINING_RUN_REQUEST_STORE, TRAINING_SUPERVISOR_DIRECTORY,
      ...TRAINING_BROKER_SOCKET_PATHS,
      path.posix.dirname(DAIMON_GROK_ENGINE_BROKER.registrationPath),
      DAIMON_GROK_TURN_USAGE_LEDGER.directoryPath, DAIMON_WAKE_FUSE_DIRECTORY,
      ...Array.from({ length: slots }, (_, i) => trainingSlotPaths(i)).filter(p => p.slot !== slot)
        .flatMap(p => [p.root, p.workerHome, p.clockDirectory])
    ].map(path => ({ role: "context" as const, path }))
  ];
};
export const trainingSlotDescriptors = (slots = TRAINING_DEFAULT_SLOTS) =>
  Array.from({ length: assertTrainingSlotCount(slots) }, (_, slot) => ({
    ...trainingSlotPaths(slot), evaluatorPaths: trainingEvaluatorPaths(slot, slots),
    containerPaths: TRAINING_CALLER_PROTECTED_PATHS.map(path => ({ path })),
    controlRoot: trainingSlotPaths(slot).state
  }));
export type TrainingSlotDescriptor = ReturnType<typeof trainingSlotDescriptors>[number];
export interface TrainingSlotsDocument {
  schema: typeof TRAINING_SLOTS_VERSION;
  slots: { index: number; workerUid: number; roots: Record<string, string>; ports: { base: number; count: number } }[];
}
export const trainingSlotsDocument = (slots = TRAINING_DEFAULT_SLOTS): TrainingSlotsDocument => ({
  schema: TRAINING_SLOTS_VERSION,
  slots: trainingSlotDescriptors(slots).map(p => ({
    index: p.slot, workerUid: p.workerUid,
    // Training owns a runtime-neutral lease pool: its strict descriptor carries opaque named paths.
    roots: {
      ...Object.fromEntries(Object.entries(p).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
      home: p.runtimeHome, control: p.state, context: TRAINING_ROOT,
      ...Object.fromEntries(p.evaluatorPaths.map((entry, index) => [`evaluator:${entry.role}:${index}`, entry.path])),
      ...Object.fromEntries(p.containerPaths.map((entry, index) => [`container:${index}`, entry.path]))
    },
    ports: { base: p.ports.base, count: p.ports.stride }
  }))
});

/** Both sides derive the descriptor bytes; a stale or edited bind must never certify a different pool. */
export const assertTrainingSlotsDocument = (value: unknown, slots: number): void => {
  if (JSON.stringify(value) !== JSON.stringify(trainingSlotsDocument(slots))) throw Error("Training slots manifest differs from the broker declaration");
};

/** Shared deny targets exist before worker attestation; no per-slot subtree is touched here. */
export const TRAINING_OPTIONAL_DENY_DIRECTORIES: readonly string[] = [
  TRAINING_BROKER_TMPDIR, TRAINING_INFERENCE_DIRECTORY, TRAINING_TURN_STORE_ROOT,
  TRAINING_SUPERVISOR_DIRECTORY, TRAINING_GRANT_HOME_ROOT,
  DAIMON_GROK_TURN_USAGE_LEDGER.directoryPath, DAIMON_WAKE_FUSE_DIRECTORY
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
 * Deny entries the launch binds from the host, named so a refusal can say why.
 *
 * Only the run root is one. The sealed inputs root is **not**: the launch binds
 * each declared input at `/run/training/inputs/<id>`, so `/run/training/inputs`
 * itself is the binds' *parent*, a directory on the read-only image root — and
 * that is exactly what makes it sealable (see `TRAINING_SEALED_DENY_PATHS`).
 *
 * Being a host bind is no longer a waiver on its own. On Docker Desktop and
 * Colima a bind lands on virtiofs/grpcfuse, which ignores `chown`, and there a
 * worker-uid probe carries no information; on a Linux daemon over ext4, xfs,
 * btrfs or overlay the same bind enforces ownership and the probe is real. The
 * canary resolver asks the backing filesystem rather than this list, which is
 * why the documented `refuse` default is reachable at all.
 */
export const TRAINING_HOST_BIND_DENY_PATHS: readonly string[] = [TRAINING_RUN_ROOT, DAIMON_GROK_SUBSCRIPTION_REALM.bootstrapMountPath];

/**
 * Deny entries whose denial must be proven by the kernel under **every**
 * policy, because the experiment's central claim depends on them.
 *
 * `/run/training/inputs` holds the sealed train and test datasets. A bubblewrap
 * `deny` mask is not a boundary the subject cannot lift: the pinned seccomp
 * profile must allow `clone/unshare/mount/umount2/pivot_root/setns` for
 * bubblewrap itself, and the container runs `apparmor=unconfined`, so a
 * worker-uid process can open a user + mount namespace of its own and either
 * detach the mask or bind the mask's parent somewhere fresh.
 *
 * What survives that is DAC on the datasets' ancestor. The image bakes this
 * directory `0:<organization gid> 0750` on the read-only root, so:
 *
 *   - the worker uid is in neither the owner nor the group class and loses
 *     search permission on the one directory every dataset read must traverse;
 *   - the inode is owned by real uid 0, which a `unshare --map-root-user`
 *     namespace does not map, so `CAP_DAC_OVERRIDE` there cannot override it;
 *   - the root filesystem is read-only, so nothing in the container — root
 *     included — can loosen the mode after the image is built.
 *
 * Provisioning asserts the mode and then attacks it as the worker uid, and the
 * canary resolver refuses the slot rather than certifying one of these on the
 * sandbox profile alone.
 */
export const TRAINING_SEALED_DENY_PATHS: readonly string[] = [TRAINING_SEALED_INPUTS_ROOT];

/** Spawnfile-owned per-route seal attestation, written by provisioning beside the slot preflight receipt. */


/** The image-baked identity of the sealed inputs root, asserted before every slot and never writable at runtime. */
export const TRAINING_SEALED_INPUTS_IDENTITY = { uid: 0, gid: DAIMON_ORGANIZATION_UID, mode: "750" } as const;

/**
 * What a recycle removes outright, and what it only empties.
 *
 * Nothing the launch mounts may be at or below any of these. A mount point
 * cannot be unlinked while it is mounted, so a wipe target holding one aborts
 * the recycle — which is how the broker/relay `TMPDIR` took down a live launch
 * when it still lived at `<control root>/tmp`. `paths.test.ts` enforces that
 * against the launch's own mount list; the rendered shell skips mount points
 * anyway, so an undeclared one degrades to "left in place and reported" rather
 * than a failed provision.
 */
export const trainingWipeTargets = (slot: number): readonly string[] => {
  const p = trainingSlotPaths(slot);
  return [p.runtimeHome, p.state, p.preflightReceipt, p.sealedInputsAttestation];
};
/** Broker-owned turns and clocks are reset through its control seam, never by filesystem deletion. */
export const trainingClearTargets = (slot: number): readonly string[] => {
  const p = trainingSlotPaths(slot);
  return [p.workspace, p.usageDirectory];
};

export const TRAINING_REALM_MOUNT = DAIMON_GROK_SUBSCRIPTION_REALM.durableMountPath;
export const TRAINING_BOOTSTRAP_MOUNT = DAIMON_GROK_SUBSCRIPTION_REALM.bootstrapMountPath;
export { DAIMON_BROKER_UID, DAIMON_ORGANIZATION_UID };
