import path from "node:path";

import { DAIMON_GROK_ENGINE_BROKER, DAIMON_GROK_TURN_USAGE_LEDGER } from "../../../runtime/daimon/contractManifest.js";
import { DAIMON_WAKE_FUSE_DIRECTORY } from "../../../runtime/daimon/config.js";
import type { DaimonGrokRegistration } from "../../containerDaimonGrokWorkerRender.js";
import { renderDaimonBrokerProvisioningProgram } from "../../containerDaimonBrokerRender.js";
import { renderDaimonGrokHostPreflight } from "../../containerDaimonGrokWorkerProvisioning.js";
import {
  DAIMON_BROKER_UID,
  DAIMON_ORGANIZATION_UID,
  TRAINING_GRANT_HOME_ROOT,
  TRAINING_INFERENCE_DIRECTORY,
  TRAINING_INFERENCE_LEDGER,
  TRAINING_OPTIONAL_DENY_DIRECTORIES,
  TRAINING_PAIDEIA_ROOT,
  TRAINING_SLOT_ACCEPTANCE_STORE,
  TRAINING_SEALED_INPUTS_IDENTITY,
  TRAINING_SEALED_INPUTS_ROOT,
  TRAINING_SLOT_ROOT,
  TRAINING_SLOT_STATE_ROOT,
  TRAINING_SLOT_TURN_STORE,
  TRAINING_SLOT_USAGE_DIRECTORY,
  TRAINING_SLOT_USAGE_LEDGER,
  TRAINING_SUPERVISOR_DIRECTORY,
  TRAINING_BROKER_TMPDIR,
  TRAINING_SLOT_WORKSPACE,
  TRAINING_WORKER_ROOT,
  TRAINING_WORKER_UID
} from "./paths.js";

const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

/**
 * Root only ever chmods an inode it currently owns: the container's capability
 * set grants `CAP_CHOWN` but not `CAP_FOWNER` (P0 §2), so `install -d -o u -g g
 * -m m` — which chowns before it chmods — fails with `EPERM` for every
 * non-root owner. Reclaim, set the mode, then hand over.
 */
const PROVISION_DIRECTORY_HELPER = [
  "provision_dir() {",
  "  target=$1; mode=$2; owner=$3; group=$4",
  "  test -d \"$target\" && test ! -L \"$target\"",
  "  chown 0:0 \"$target\"; chmod \"$mode\" \"$target\"; chown \"$owner:$group\" \"$target\"",
  "}"
];

/**
 * Every directory the training slot owns, with the identity that must hold it.
 *
 * The two ledger directories are setgid to the organization group on purpose:
 * the broker writes its rows `0640` owned by the broker group, so without
 * `2100:2000 2750` uid 2000 — Paideia, DSPy and every judge — cannot read a
 * single subject usage row or inference row it paid for.
 */
export const trainingSlotDirectories = (): readonly { path: string; mode: string; uid: number; gid: number }[] => [
  // `/run/training` itself is deliberately absent: it is a mount-point parent on the read-only
  // image root, and every writable child below it is its own tmpfs or bind.
  { path: TRAINING_SLOT_ROOT, mode: "0755", uid: 0, gid: 0 },
  { path: TRAINING_PAIDEIA_ROOT, mode: "0750", uid: DAIMON_ORGANIZATION_UID, gid: DAIMON_ORGANIZATION_UID },
  { path: "/home/training", mode: "0700", uid: DAIMON_ORGANIZATION_UID, gid: DAIMON_ORGANIZATION_UID },
  { path: "/work", mode: "0700", uid: DAIMON_ORGANIZATION_UID, gid: DAIMON_ORGANIZATION_UID },
  { path: TRAINING_SLOT_WORKSPACE, mode: "0750", uid: DAIMON_ORGANIZATION_UID, gid: TRAINING_WORKER_UID },
  // The agent runtime home is deliberately absent: the shared broker provisioning creates it root-owned,
  // fills its setgid `tool-output/`, and only then narrows it to `2000:<worker> 0710`. Handing it over here
  // would leave root — which holds no `CAP_DAC_OVERRIDE` — unable to create the spill directory inside it.
  { path: TRAINING_SLOT_STATE_ROOT, mode: "0700", uid: DAIMON_ORGANIZATION_UID, gid: DAIMON_ORGANIZATION_UID },
  { path: TRAINING_SLOT_ACCEPTANCE_STORE, mode: "0700", uid: DAIMON_ORGANIZATION_UID, gid: DAIMON_ORGANIZATION_UID },
  { path: TRAINING_SLOT_TURN_STORE, mode: "0700", uid: DAIMON_BROKER_UID, gid: DAIMON_BROKER_UID },
  { path: TRAINING_SLOT_USAGE_DIRECTORY, mode: "2750", uid: DAIMON_BROKER_UID, gid: DAIMON_ORGANIZATION_UID },
  { path: TRAINING_INFERENCE_DIRECTORY, mode: "2750", uid: DAIMON_BROKER_UID, gid: DAIMON_ORGANIZATION_UID },
  { path: TRAINING_GRANT_HOME_ROOT, mode: "0700", uid: DAIMON_ORGANIZATION_UID, gid: DAIMON_ORGANIZATION_UID },
  // Traverse only: the supervisor socket inside it is the uid gate, and a directory nobody but root may
  // write is what keeps that socket from being replaced by a laxer one.
  { path: TRAINING_SUPERVISOR_DIRECTORY, mode: "0711", uid: 0, gid: 0 },
  // The broker and its relay run as uid 2100, outside the organization group, and shared `/tmp` is closed
  // to them; this is their own temp, outside every wipe target (see `TRAINING_BROKER_TMPDIR`).
  { path: TRAINING_BROKER_TMPDIR, mode: "0700", uid: DAIMON_BROKER_UID, gid: DAIMON_BROKER_UID },
  { path: TRAINING_WORKER_ROOT, mode: "0711", uid: 0, gid: 0 },
  // Denied and unused by training, which meters per slot — but a world-readable directory would make its
  // worker-uid canary meaningless, so both get the modes the production organization gives them.
  { path: DAIMON_GROK_TURN_USAGE_LEDGER.directoryPath, mode: "0750", uid: DAIMON_BROKER_UID, gid: DAIMON_ORGANIZATION_UID },
  { path: DAIMON_WAKE_FUSE_DIRECTORY, mode: "0700", uid: DAIMON_ORGANIZATION_UID, gid: DAIMON_ORGANIZATION_UID }
];

/**
 * The fixed identities the slot needs, checked rather than created.
 *
 * The broker-capable training container runs on a read-only root, so
 * `/etc/passwd` and `/etc/group` cannot be written at start-up the way the
 * production Daimon entrypoint writes them. The image bakes uid/gid 2000, 2100
 * and the worker uid instead, and this refuses to provision a slot in an image
 * that did not.
 */
export const renderTrainingIdentities = (): string[] => [
  `for fixed_uid in ${DAIMON_ORGANIZATION_UID} ${DAIMON_BROKER_UID} ${TRAINING_WORKER_UID}; do`,
  '  getent passwd "$fixed_uid" >/dev/null && getent group "$fixed_uid" >/dev/null || { echo "the training image must bake uid/gid $fixed_uid; the container root is read-only" >&2; exit 1; }',
  "done"
];

/**
 * Root provisioning for the training container's one broker slot, as bash
 * lines run by the image's own root entrypoint and replayed verbatim by the
 * slot supervisor on every recycle.
 *
 * Everything below the slot skeleton is Daimon's audited production
 * provisioning: the same credential bootstrap and journal recovery, the same
 * `registrations.bin`, the same attested worker `GROK_HOME` layout, the same
 * P1b private worker temp, closed shared temp and setgid spill directory, and
 * the same `service.json` — here v2 with the per-slot usage ledger, the
 * per-slot tmpfs turn store and the evaluator `inferenceLedgerPath`.
 */
export const renderTrainingBrokerProvisioning = (registration: DaimonGrokRegistration): string[] => [
  ...PROVISION_DIRECTORY_HELPER,
  // Two passes, because root here holds neither `CAP_DAC_OVERRIDE` nor `CAP_FOWNER`: create every
  // directory while they are all still root-owned and traversable, then set ownership and mode from the
  // deepest path up, so tightening a parent to `0700` never strands a child that still has to be created.
  ...trainingSlotDirectories().map((entry) => `mkdir -p ${quote(entry.path)}`),
  // Every deny entry needs an inode to mask; a bind the host did not supply is created root-owned and unreadable.
  ...TRAINING_OPTIONAL_DENY_DIRECTORIES.map((target) => `if [ ! -e ${quote(target)} ]; then mkdir -p ${quote(target)}; provision_dir ${quote(target)} 0700 0 0; fi`),
  // Both ledgers exist before their directories are handed to the broker: the broker appends rows `0640` in
  // its own group, and the setgid directory below is what lets uid 2000 read a row it paid for.
  ...[TRAINING_SLOT_USAGE_LEDGER, TRAINING_INFERENCE_LEDGER].map((ledger) =>
    `if [ ! -e ${quote(ledger)} ]; then : > ${quote(ledger)}; fi; chown 0:0 ${quote(ledger)}; chmod 0640 ${quote(ledger)}; chown ${DAIMON_BROKER_UID}:${DAIMON_ORGANIZATION_UID} ${quote(ledger)}`),
  ...[...trainingSlotDirectories()].sort((left, right) => right.path.split("/").length - left.path.split("/").length)
    .map((entry) => `provision_dir ${quote(entry.path)} ${entry.mode} ${entry.uid} ${entry.gid}`),
  ...renderDaimonGrokHostPreflight(),
  ...renderDaimonBrokerProvisioningProgram([registration], [], {
    turnStore: TRAINING_SLOT_TURN_STORE,
    inferenceLedgerPath: TRAINING_INFERENCE_LEDGER
  }, "clear", TRAINING_OPTIONAL_DENY_DIRECTORIES, TRAINING_BROKER_TMPDIR),
  // The shared program leaves the broker's `/etc` root `0555 root:root`, which every uid can list. Training
  // denies that directory to its worker, and a canary can only observe a denial the kernel actually enforces.
  `chmod 0550 /etc/daimon-engine-broker; chown 0:${DAIMON_BROKER_UID} /etc/daimon-engine-broker`,
  `test "$(stat -c '%u:%g %a' ${quote(TRAINING_SLOT_USAGE_DIRECTORY)})" = "${DAIMON_BROKER_UID}:${DAIMON_ORGANIZATION_UID} 2750"`,
  `test "$(stat -c '%u:%g %a' ${quote(TRAINING_INFERENCE_DIRECTORY)})" = "${DAIMON_BROKER_UID}:${DAIMON_ORGANIZATION_UID} 2750"`,
  `test "$(stat -c '%u:%g %a' ${quote(TRAINING_GRANT_HOME_ROOT)})" = "${DAIMON_ORGANIZATION_UID}:${DAIMON_ORGANIZATION_UID} 700"`,
  // The judge grant home root is the evaluator's alone: no worker uid may even traverse it.
  `setpriv --clear-groups --reuid ${TRAINING_WORKER_UID} --regid ${TRAINING_WORKER_UID} --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- bash -ceu '! test -r ${quote(TRAINING_GRANT_HOME_ROOT)}'`,
  `setpriv --clear-groups --reuid ${DAIMON_ORGANIZATION_UID} --regid ${DAIMON_ORGANIZATION_UID} --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- bash -ceu 'test -r ${quote(TRAINING_SLOT_USAGE_LEDGER)} && test -r ${quote(TRAINING_INFERENCE_LEDGER)}'`,
  // The sealed train and test datasets: the one boundary here that must hold against the subject's own
  // namespace, not only against an honest tool. Last, so it runs with every mode already final.
  ...renderTrainingSealedInputsAssertions(registration.uid)
];

/**
 * The sealed-inputs seal, asserted and then attacked before any slot is used.
 *
 * The declared datasets are bind-mounted at `/run/training/inputs/<id>`, so
 * `/run/training/inputs` is their common ancestor and the only inode in the
 * chain the container controls: it lives on the read-only image root, the image
 * bakes it `0:<organization gid> 0750`, and nothing in the container can widen
 * it afterwards. The worker uid is in neither its owner nor its group class, so
 * it loses *search* permission on the directory every dataset read must
 * traverse.
 *
 * The three probes below are the attacker's route, not a cooperating tool's:
 *
 *  1. a direct read/search/list as the worker uid;
 *  2. a user + mount namespace of the worker's own, detaching the bubblewrap
 *     `deny` mask and the parent mount, then listing again — the route that
 *     makes `profile-only` an unsound boundary for this path;
 *  3. the same namespace, binding `/run/training` somewhere fresh so the bind
 *     carries no `deny` mask, then listing through it.
 *
 * (2) and (3) are the ones the mask cannot answer and DAC can: `--map-root-user`
 * maps only the worker uid, so `CAP_DAC_OVERRIDE` in that namespace is
 * ineffective against a root-owned inode, and a fresh bind re-exposes the same
 * root-owned directory rather than the bytes under it. A probe that reaches no
 * verdict refuses the slot; a worker that cannot create the namespace at all
 * cannot take the route, and says so.
 */
export const renderTrainingSealedInputsAssertions = (workerUid = TRAINING_WORKER_UID): string[] => [
  "sealed_denied() {",
  `  sealed_out=$(setpriv --clear-groups --reuid ${workerUid} --regid ${workerUid} --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- /bin/sh -c "$1" 2>&1) || true`,
  '  case "$sealed_out" in',
  `    *SEALED-REACHABLE*) echo "the sealed inputs root ${TRAINING_SEALED_INPUTS_ROOT} is reachable by uid ${workerUid} via $2" >&2; exit 1 ;;`,
  '    *SEALED-DENIED*) echo "sealed inputs denial observed for $2" ;;',
  '    *SEALED-NO-NAMESPACE*) echo "sealed inputs probe $2 could not open a user namespace as the worker uid, so that route does not exist here" ;;',
  '    *) echo "sealed inputs probe $2 reached no verdict, so the denial is unproven: $sealed_out" >&2; exit 1 ;;',
  "  esac",
  "}",
  // Asserted, never set: the root filesystem is read-only, so an image that did not bake this mode
  // cannot be corrected here — and that is the point. Refuse instead.
  `test ! -L ${quote(TRAINING_SEALED_INPUTS_ROOT)} && test -d ${quote(TRAINING_SEALED_INPUTS_ROOT)}`,
  `if [ "$(stat -c '%u:%g %a' ${quote(TRAINING_SEALED_INPUTS_ROOT)})" != "${TRAINING_SEALED_INPUTS_IDENTITY.uid}:${TRAINING_SEALED_INPUTS_IDENTITY.gid} ${TRAINING_SEALED_INPUTS_IDENTITY.mode}" ]; then`,
  `  echo "the training image must bake ${TRAINING_SEALED_INPUTS_ROOT} as ${TRAINING_SEALED_INPUTS_IDENTITY.uid}:${TRAINING_SEALED_INPUTS_IDENTITY.gid} ${TRAINING_SEALED_INPUTS_IDENTITY.mode} on its read-only root; the sealed datasets are unprotected otherwise" >&2; exit 1`,
  "fi",
  `sealed_denied "if ls -1 ${TRAINING_SEALED_INPUTS_ROOT} >/dev/null 2>&1 || test -r ${TRAINING_SEALED_INPUTS_ROOT} || test -x ${TRAINING_SEALED_INPUTS_ROOT}; then echo SEALED-REACHABLE; else echo SEALED-DENIED; fi" direct-read`,
  `sealed_denied "unshare --user --map-root-user --mount -- /bin/sh -c 'umount -l ${TRAINING_SEALED_INPUTS_ROOT} >/dev/null 2>&1; umount -l /run/training >/dev/null 2>&1; if ls -1 ${TRAINING_SEALED_INPUTS_ROOT} >/dev/null 2>&1; then echo SEALED-REACHABLE; else echo SEALED-DENIED; fi; exit 0' || echo SEALED-NO-NAMESPACE" namespace-unmount`,
  `sealed_denied "unshare --user --map-root-user --mount -- /bin/sh -c 'mkdir -p /tmp/.sealed-probe >/dev/null 2>&1 || exit 0; mount --bind /run/training /tmp/.sealed-probe >/dev/null 2>&1 || { echo SEALED-DENIED; exit 0; }; if ls -1 /tmp/.sealed-probe/inputs >/dev/null 2>&1; then echo SEALED-REACHABLE; else echo SEALED-DENIED; fi; exit 0' || echo SEALED-NO-NAMESPACE" namespace-rebind`,
  // Per dataset, because the strongest route is specific: binding the *dataset's own mount* somewhere
  // fresh carries no `deny` mask and is not refused for locked children the way binding their parent is.
  // A live control container with this directory left at Docker's own `0755 root:root` handed the held-out
  // answer key to uid 2200 through exactly this route. Root enumerates the children; the worker may not.
  `for sealed_child in ${TRAINING_SEALED_INPUTS_ROOT}/*; do`,
  '  test -e "$sealed_child" || continue',
  `  sealed_denied "if ls -1 \\"$sealed_child\\" >/dev/null 2>&1 || cat \\"$sealed_child\\"/* >/dev/null 2>&1; then echo SEALED-REACHABLE; else echo SEALED-DENIED; fi" "direct-read $sealed_child"`,
  `  sealed_denied "unshare --user --map-root-user --mount -- /bin/sh -c \\"mkdir -p /tmp/.sealed-probe-child >/dev/null 2>&1 || exit 0; mount --bind '$sealed_child' /tmp/.sealed-probe-child >/dev/null 2>&1 || { echo SEALED-DENIED; exit 0; }; if ls -1 /tmp/.sealed-probe-child >/dev/null 2>&1; then echo SEALED-REACHABLE; else echo SEALED-DENIED; fi; exit 0\\" || echo SEALED-NO-NAMESPACE" "namespace-rebind $sealed_child"`,
  "done"
];

/** Where the broker's own `service.json` lands, so the supervisor can prove the slot it restarted is the slot it provisioned. */
export const TRAINING_SERVICE_CONFIG_PATH = DAIMON_GROK_ENGINE_BROKER.serviceConfigPath;
export const TRAINING_REGISTRATION_PATH = DAIMON_GROK_ENGINE_BROKER.registrationPath;
export const TRAINING_BROKER_CONTROL_ROOT = path.posix.dirname(DAIMON_GROK_ENGINE_BROKER.controlSocketPath);
