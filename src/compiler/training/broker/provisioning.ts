import path from "node:path";

import { DAIMON_GROK_ENGINE_BROKER } from "../../../runtime/daimon/contractManifest.js";
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
  TRAINING_SLOT_RUNTIME_HOME,
  TRAINING_SLOT_STATE_ROOT,
  TRAINING_SLOT_TURN_STORE,
  TRAINING_SLOT_USAGE_DIRECTORY,
  TRAINING_SLOT_USAGE_LEDGER,
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
  "  mkdir -p \"$target\"",
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
  { path: "/run/training", mode: "0755", uid: 0, gid: 0 },
  { path: TRAINING_SLOT_ROOT, mode: "0755", uid: 0, gid: 0 },
  { path: TRAINING_PAIDEIA_ROOT, mode: "0750", uid: DAIMON_ORGANIZATION_UID, gid: DAIMON_ORGANIZATION_UID },
  { path: TRAINING_SLOT_WORKSPACE, mode: "0750", uid: DAIMON_ORGANIZATION_UID, gid: TRAINING_WORKER_UID },
  { path: TRAINING_SLOT_RUNTIME_HOME, mode: "0710", uid: DAIMON_ORGANIZATION_UID, gid: TRAINING_WORKER_UID },
  { path: TRAINING_SLOT_STATE_ROOT, mode: "0700", uid: DAIMON_ORGANIZATION_UID, gid: DAIMON_ORGANIZATION_UID },
  { path: TRAINING_SLOT_ACCEPTANCE_STORE, mode: "0700", uid: DAIMON_ORGANIZATION_UID, gid: DAIMON_ORGANIZATION_UID },
  { path: TRAINING_SLOT_TURN_STORE, mode: "0700", uid: DAIMON_BROKER_UID, gid: DAIMON_BROKER_UID },
  { path: TRAINING_SLOT_USAGE_DIRECTORY, mode: "2750", uid: DAIMON_BROKER_UID, gid: DAIMON_ORGANIZATION_UID },
  { path: TRAINING_INFERENCE_DIRECTORY, mode: "2750", uid: DAIMON_BROKER_UID, gid: DAIMON_ORGANIZATION_UID },
  { path: TRAINING_GRANT_HOME_ROOT, mode: "0700", uid: DAIMON_ORGANIZATION_UID, gid: DAIMON_ORGANIZATION_UID },
  { path: TRAINING_WORKER_ROOT, mode: "0711", uid: 0, gid: 0 }
];

/** Fixed uid/gid identities the slot needs before anything is provisioned. */
export const renderTrainingIdentities = (): string[] => [
  `for fixed_uid in ${DAIMON_ORGANIZATION_UID} ${DAIMON_BROKER_UID} ${TRAINING_WORKER_UID}; do`,
  '  if ! getent group "$fixed_uid" >/dev/null; then groupadd -K GID_MIN=1 --gid "$fixed_uid" "daimon-$fixed_uid"; fi',
  '  if ! getent passwd "$fixed_uid" >/dev/null; then useradd -K UID_MIN=1 --no-create-home --no-log-init --uid "$fixed_uid" --gid "$fixed_uid" --home-dir /nonexistent --shell /usr/sbin/nologin "daimon-$fixed_uid"; fi',
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
  ...trainingSlotDirectories().map((entry) => `provision_dir ${quote(entry.path)} ${entry.mode} ${entry.uid} ${entry.gid}`),
  // Every deny entry needs an inode to mask; a bind the host did not supply is created root-owned and unreadable.
  ...TRAINING_OPTIONAL_DENY_DIRECTORIES.map((target) => `if [ ! -e ${quote(target)} ]; then provision_dir ${quote(target)} 0700 0 0; fi`),
  ...renderDaimonGrokHostPreflight(),
  ...renderDaimonBrokerProvisioningProgram([registration], [], {
    turnStore: TRAINING_SLOT_TURN_STORE,
    inferenceLedgerPath: TRAINING_INFERENCE_LEDGER
  }),
  // The broker creates both ledgers 0640 in its own group; the setgid directories above give the group to uid 2000.
  ...[TRAINING_SLOT_USAGE_LEDGER, TRAINING_INFERENCE_LEDGER].map((ledger) =>
    `if [ ! -e ${quote(ledger)} ]; then : > ${quote(ledger)}; chown 0:0 ${quote(ledger)}; chmod 0640 ${quote(ledger)}; chown ${DAIMON_BROKER_UID}:${DAIMON_ORGANIZATION_UID} ${quote(ledger)}; fi`),
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
