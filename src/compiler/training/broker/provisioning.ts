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
  `setpriv --clear-groups --reuid ${DAIMON_ORGANIZATION_UID} --regid ${DAIMON_ORGANIZATION_UID} --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- bash -ceu 'test -r ${quote(TRAINING_SLOT_USAGE_LEDGER)} && test -r ${quote(TRAINING_INFERENCE_LEDGER)}'`
];

/** Where the broker's own `service.json` lands, so the supervisor can prove the slot it restarted is the slot it provisioned. */
export const TRAINING_SERVICE_CONFIG_PATH = DAIMON_GROK_ENGINE_BROKER.serviceConfigPath;
export const TRAINING_REGISTRATION_PATH = DAIMON_GROK_ENGINE_BROKER.registrationPath;
export const TRAINING_BROKER_CONTROL_ROOT = path.posix.dirname(DAIMON_GROK_ENGINE_BROKER.controlSocketPath);
