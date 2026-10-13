import path from "node:path";

import { DAIMON_GROK_SECCOMP_PROFILE_SHA256 } from "../../../shared/daimonGrokSeccompProfile.js";
import { DAIMON_GROK_ENGINE_BROKER, DAIMON_GROK_TURN_USAGE_LEDGER } from "../../../runtime/daimon/contractManifest.js";
import { DAIMON_WAKE_FUSE_DIRECTORY } from "../../../runtime/daimon/config.js";
import type { DaimonGrokRegistration } from "../../containerDaimonGrokWorkerRender.js";
import { renderDaimonBrokerProvisioningProgram, renderDaimonWorkspaceResourceSecurity } from "../../containerDaimonBrokerRender.js";
import { renderDaimonGrokHostPreflight, renderDaimonGrokWorkerProvisioning } from "../../containerDaimonGrokWorkerProvisioning.js";
import {
  TRAINING_BROKER_SOCKET_PATHS, trainingSlotPaths, trainingSlotDescriptors, TRAINING_TURN_STORE_ROOT, TRAINING_RUN_REQUEST_STORE,
  DAIMON_BROKER_UID,
  DAIMON_ORGANIZATION_UID,
  TRAINING_GRANT_HOME_ROOT,
  TRAINING_INFERENCE_DIRECTORY,
  TRAINING_INFERENCE_LEDGER,
  TRAINING_OPTIONAL_DENY_DIRECTORIES,
  TRAINING_PAIDEIA_ROOT,
  TRAINING_SEALED_INPUTS_IDENTITY,
  TRAINING_SEALED_INPUTS_ROOT,
  TRAINING_SUPERVISOR_DIRECTORY,
  TRAINING_BROKER_TMPDIR,
  TRAINING_WORKER_ROOT,
} from "./paths.js";
import { trainingNamespaceDenialMechanism } from "./seccompRoutes.js";

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
export const trainingSlotDirectories = (slot = 0): readonly { path: string; mode: string; uid: number; gid: number }[] => [
  // `/run/training` itself is deliberately absent: it is a mount-point parent on the read-only
  // image root, and every writable child below it is its own tmpfs or bind.
  { path: trainingSlotPaths(slot).root, mode: "0711", uid: 0, gid: 0 },
  { path: TRAINING_PAIDEIA_ROOT, mode: "0750", uid: DAIMON_ORGANIZATION_UID, gid: DAIMON_ORGANIZATION_UID },
  { path: "/home/training", mode: "0700", uid: DAIMON_ORGANIZATION_UID, gid: DAIMON_ORGANIZATION_UID },
  { path: "/work", mode: "0700", uid: DAIMON_ORGANIZATION_UID, gid: DAIMON_ORGANIZATION_UID },
  { path: trainingSlotPaths(slot).workspace, mode: "0750", uid: DAIMON_ORGANIZATION_UID, gid: trainingSlotPaths(slot).workerUid },
  // The agent runtime home is deliberately absent: the shared broker provisioning creates it root-owned,
  // fills its setgid `tool-output/`, and only then narrows it to `2000:<worker> 0710`. Handing it over here
  // would leave root — which holds no `CAP_DAC_OVERRIDE` — unable to create the spill directory inside it.
  { path: trainingSlotPaths(slot).state, mode: "0700", uid: DAIMON_ORGANIZATION_UID, gid: DAIMON_ORGANIZATION_UID },
  { path: trainingSlotPaths(slot).acceptanceStore, mode: "0700", uid: DAIMON_ORGANIZATION_UID, gid: DAIMON_ORGANIZATION_UID },
  { path: TRAINING_TURN_STORE_ROOT, mode: "0700", uid: DAIMON_BROKER_UID, gid: DAIMON_BROKER_UID },
  { path: TRAINING_RUN_REQUEST_STORE, mode: "0700", uid: DAIMON_BROKER_UID, gid: DAIMON_BROKER_UID },
  { path: trainingSlotPaths(slot).usageDirectory, mode: "2750", uid: DAIMON_BROKER_UID, gid: DAIMON_ORGANIZATION_UID },
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
export const renderTrainingIdentities = (slots = 4): string[] => [
  `for fixed_uid in ${DAIMON_ORGANIZATION_UID} ${DAIMON_BROKER_UID} ${trainingSlotDescriptors(slots).map(p => p.workerUid).join(" ")}; do`,
  '  getent passwd "$fixed_uid" >/dev/null && getent group "$fixed_uid" >/dev/null || { echo "the training image must bake uid/gid $fixed_uid; the container root is read-only" >&2; exit 1; }',
  "done"
];

/** Slot-local skeleton, shared by initial provisioning and recycle. */
const slotDirectories = (slot: number) => trainingSlotDirectories(slot).filter(entry =>
  entry.path === trainingSlotPaths(slot).root || entry.path.startsWith(`${trainingSlotPaths(slot).root}/`));
const renderDirectories = (entries: ReturnType<typeof trainingSlotDirectories>, ledgers: string[]): string[] => [
  ...PROVISION_DIRECTORY_HELPER,
  ...entries.map(entry => `mkdir -p ${quote(entry.path)}`),
  ...ledgers.map(ledger => `if [ ! -e ${quote(ledger)} ]; then : > ${quote(ledger)}; fi; chown 0:0 ${quote(ledger)}; chmod 0640 ${quote(ledger)}; chown ${DAIMON_BROKER_UID}:${DAIMON_ORGANIZATION_UID} ${quote(ledger)}`),
  ...[...entries].sort((a, b) => b.path.split("/").length - a.path.split("/").length)
    .map(entry => `provision_dir ${quote(entry.path)} ${entry.mode} ${entry.uid} ${entry.gid}`)
];

const renderSlotAssertions = (r: DaimonGrokRegistration): string[] => [
  `test "$(stat -c '%u:%g %a' ${quote(trainingSlotPaths(r.slot).usageDirectory)})" = "${DAIMON_BROKER_UID}:${DAIMON_ORGANIZATION_UID} 2750"`,
  `test "$(stat -c '%u:%g %a' ${quote(TRAINING_INFERENCE_DIRECTORY)})" = "${DAIMON_BROKER_UID}:${DAIMON_ORGANIZATION_UID} 2750"`,
  `test "$(stat -c '%u:%g %a' ${quote(TRAINING_GRANT_HOME_ROOT)})" = "${DAIMON_ORGANIZATION_UID}:${DAIMON_ORGANIZATION_UID} 700"`,
  `setpriv --clear-groups --reuid ${r.uid} --regid ${r.uid} --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- bash -ceu '! test -r ${quote(TRAINING_GRANT_HOME_ROOT)}'`,
  `setpriv --clear-groups --reuid ${DAIMON_ORGANIZATION_UID} --regid ${DAIMON_ORGANIZATION_UID} --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- bash -ceu 'test -r ${quote(r.usageLedgerPath)} && test -r ${quote(TRAINING_INFERENCE_LEDGER)}'`
];

/** Full container provisioning runs exactly once, before any broker process starts. */
export const renderTrainingBrokerProvisioning = (input: DaimonGrokRegistration | readonly DaimonGrokRegistration[], maxRunRequests = 1000): string[] => {
  if (!Number.isSafeInteger(maxRunRequests) || maxRunRequests < 1) throw new Error("Invalid run request cap");
  const registrations = Array.isArray(input) ? input : [input as DaimonGrokRegistration];
  const directories = [...new Map(registrations.flatMap(r => trainingSlotDirectories(r.slot)).map(d => [d.path, d])).values()];
  return [
    ...renderTrainingIdentities(registrations.length),
    ...renderDirectories(directories, [...registrations.map(r => r.usageLedgerPath), TRAINING_INFERENCE_LEDGER]),
    ...renderDaimonGrokHostPreflight(),
    ...renderDaimonBrokerProvisioningProgram(registrations, [], {
      version: "v3", maxRunRequests, runRequestStore: TRAINING_RUN_REQUEST_STORE,
      turnStore: TRAINING_TURN_STORE_ROOT, inferenceLedgerPath: TRAINING_INFERENCE_LEDGER
    }, "clear", TRAINING_OPTIONAL_DENY_DIRECTORIES, TRAINING_BROKER_TMPDIR, [
      // Placeholders exist for deny placement only; service startup must see absent socket paths.
      ...TRAINING_BROKER_SOCKET_PATHS.map(socket => `touch ${quote(socket)}; chmod 000 ${quote(socket)}`),
      `mkdir -p ${quote(DAIMON_GROK_ENGINE_BROKER.worker.taskClock.rootDirectoryPath)}; chmod 0755 ${quote(DAIMON_GROK_ENGINE_BROKER.worker.taskClock.rootDirectoryPath)}`,
      ...registrations.flatMap(r => {
        const p = trainingSlotPaths(r.slot);
        return [
          `mkdir -p ${quote(p.clockDirectory)}; chown 0:0 ${quote(p.clockDirectory)}; chmod 0755 ${quote(p.clockDirectory)}`,
          `printf '+0\\n' > ${quote(p.clockFile)}; chmod 0644 ${quote(p.clockFile)}; chown ${DAIMON_BROKER_UID}:${DAIMON_BROKER_UID} ${quote(p.clockFile)}`,
          `chown ${DAIMON_BROKER_UID}:${DAIMON_BROKER_UID} ${quote(p.clockDirectory)}`
        ];
      })
    ]),
    ...TRAINING_BROKER_SOCKET_PATHS.map(socket => `rm ${quote(socket)}`),
    `chmod 0550 /etc/daimon-engine-broker; chown 0:${DAIMON_BROKER_UID} /etc/daimon-engine-broker`,
    ...registrations.flatMap(r => [...renderSlotAssertions(r), ...renderTrainingSealedInputsAssertions(r.uid, r.privateTmp)])
  ];
};

/** Reuse the audited worker renderer; never touch service config, credentials, shared temps or siblings. */
export const renderTrainingSlotProvisioning = (registration: DaimonGrokRegistration): string[] => [
  ...renderDirectories(slotDirectories(registration.slot), [registration.usageLedgerPath]),
  // Keep worker-home and private-tmp identities stable: sibling turns attest them concurrently.
  `setpriv --clear-groups --reuid=${registration.uid} --regid=${registration.uid} --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- mkdir -p ${quote(registration.grokHome)}`,
  `chown 0:0 ${quote(registration.grokHome)}; chmod 0700 ${quote(registration.grokHome)}`,

  "node <<'SPAWNFILE_TRAINING_SLOT_PROVISION'",
  "const crypto = require('node:crypto'); const fs = require('node:fs');",
  ...renderDaimonWorkspaceResourceSecurity([]),
  ...renderDaimonGrokWorkerProvisioning([registration], {}, [], "slot"),
  "SPAWNFILE_TRAINING_SLOT_PROVISION",
  ...renderSlotAssertions(registration),
  ...renderTrainingSealedInputsAssertions(registration.uid, registration.privateTmp)
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
 * Four attacker routes, not a cooperating tool's read: a direct
 * read/search/list; a user + mount namespace of the worker's own with the
 * bubblewrap mask and its parent lazily unmounted; a fresh `mount --bind` of
 * `/run/training` made inside that namespace; and, per dataset, a `mount --bind`
 * of the dataset's *own* mount, which carries no mask and — unlike its parent —
 * is not refused for locked children. A live control container left at Docker's
 * own `0755 root:root` hands the held-out answer key to uid 2200 through routes
 * one, two and four (`.runtime/sealed-inputs-dac/EVIDENCE.md`).
 *
 * Every route reports one verdict, and the verdicts are deliberately not
 * interchangeable:
 *
 *  - `reachable` — the bytes were read. Refuse.
 *  - `denied at-read` — the route ran and the kernel's permission check refused
 *    the open or the list. This is the DAC seal doing the work.
 *  - `denied at-mount` — the mount the route needs was refused although the
 *    syscall is available.
 *  - `unavailable seccomp` / `unavailable kernel` — the worker uid cannot open
 *    the namespace the route needs at all, so the route provably cannot happen.
 *    That is a *stronger* denial than DAC, and naming which layer refused is
 *    the point: `EPERM` from a seccomp filter and `EPERM` from a kernel or LSM
 *    policy are indistinguishable by errno, so the mechanism is derived from
 *    the pinned profile Spawnfile ships and the declaration's digest binds
 *    (`seccompRoutes.ts`), never guessed.
 *  - anything else — no verdict. Refuse. "Provably cannot happen" and "could
 *    not tell" must never collapse into one pass.
 *
 * The probe's workspace is the worker's **private** tmp, never `/tmp`: the
 * shared temps are provisioned `root:<organization gid> 1774` so a worker lists
 * names only, and probing from there is what made the first live run refuse
 * every trial on `namespace-rebind reached no verdict` — the `mkdir` failed, not
 * the seal. The private tmp is also the workspace the subject itself has.
 */
export const renderTrainingSealedInputsAssertions = (
  workerUid = trainingSlotPaths(0).workerUid,
  privateTmp = trainingSlotPaths(0).privateTmp,
  mechanism = trainingNamespaceDenialMechanism()
): string[] => [
  // Diagnostics go to a file rather than into the verdict: a route's stderr is util-linux prose that
  // would turn every real verdict into "unknown", but a no-verdict refusal with no diagnostic is what
  // made the first live failure unreadable, so the unknown branch prints it back.
  `seal_diagnostic=${quote(`${trainingSlotPaths(workerUid - trainingSlotPaths(0).workerUid).root}/seal-probe.err`)}`,
  `seal_worker() { setpriv --clear-groups --reuid ${workerUid} --regid ${workerUid} --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- /bin/sh -c "$1" 2>"$seal_diagnostic"; }`,
  "seal_rows=''",
  'seal_record() { if [ -n "$seal_rows" ]; then seal_rows="$seal_rows,"; fi; seal_rows="$seal_rows{\\"route\\":\\"$1\\",\\"verdict\\":\\"$2\\"}"; }',
  "seal_route() {",
  '  case "$2" in',
  `    reachable) echo "the sealed inputs root ${TRAINING_SEALED_INPUTS_ROOT} is REACHABLE by uid ${workerUid} via $1" >&2; exit 1 ;;`,
  '    "denied at-read"|"denied at-mount") echo "sealed inputs route $1: $2"; seal_record "$1" "$2" ;;',
  '    "unavailable seccomp"|"unavailable kernel") echo "sealed inputs route $1: $2 — the worker uid cannot open the namespace this route needs, so it provably cannot happen"; seal_record "$1" "$2" ;;',
  '    *) echo "sealed inputs route $1 reached no verdict, so the denial is unproven: ${2:-no stdout} [stderr: $(cat "$seal_diagnostic" 2>/dev/null | tr "\\n" " " | cut -c1-400)]" >&2; exit 1 ;;',
  "  esac",
  "}",
  // One availability determination for every namespace route, so a filtered syscall is reported as the
  // verdict it is instead of surfacing as a route that mysteriously produced nothing.
  "seal_namespace=available",
  `if ! seal_worker 'unshare --user --map-root-user --mount true' >/dev/null 2>&1; then seal_namespace='unavailable ${mechanism}'; fi`,
  'seal_ns_route() { if [ "$seal_namespace" != available ]; then seal_route "$1" "$seal_namespace"; else seal_route "$1" "$(seal_worker "$2")"; fi; }',
  // Asserted, never set: the root filesystem is read-only, so an image that did not bake this mode
  // cannot be corrected here — and that is the point. Refuse instead.
  `test ! -L ${quote(TRAINING_SEALED_INPUTS_ROOT)} && test -d ${quote(TRAINING_SEALED_INPUTS_ROOT)}`,
  `if [ "$(stat -c '%u:%g %a' ${quote(TRAINING_SEALED_INPUTS_ROOT)})" != "${TRAINING_SEALED_INPUTS_IDENTITY.uid}:${TRAINING_SEALED_INPUTS_IDENTITY.gid} ${TRAINING_SEALED_INPUTS_IDENTITY.mode}" ]; then`,
  `  echo "the training image must bake ${TRAINING_SEALED_INPUTS_ROOT} as ${TRAINING_SEALED_INPUTS_IDENTITY.uid}:${TRAINING_SEALED_INPUTS_IDENTITY.gid} ${TRAINING_SEALED_INPUTS_IDENTITY.mode} on its read-only root; the sealed datasets are unprotected otherwise" >&2; exit 1`,
  "fi",
  `seal_route direct-read "$(seal_worker 'if ls -1 ${TRAINING_SEALED_INPUTS_ROOT} >/dev/null 2>&1 || test -r ${TRAINING_SEALED_INPUTS_ROOT} || test -x ${TRAINING_SEALED_INPUTS_ROOT}; then echo reachable; else echo denied at-read; fi')"`,
  `seal_ns_route namespace-unmount "unshare --user --map-root-user --mount -- /bin/sh -c 'umount -l ${TRAINING_SEALED_INPUTS_ROOT} >/dev/null 2>&1; umount -l /run/training >/dev/null 2>&1; if ls -1 ${TRAINING_SEALED_INPUTS_ROOT} >/dev/null 2>&1; then echo reachable; else echo denied at-read; fi; exit 0'"`,
  `seal_ns_route namespace-rebind-parent "unshare --user --map-root-user --mount -- /bin/sh -c 'mkdir -p ${privateTmp}/seal-parent 2>/dev/null || { echo unknown private-tmp-unwritable; exit 0; }; if mount --bind /run/training ${privateTmp}/seal-parent 2>/dev/null; then ls -1 ${privateTmp}/seal-parent/inputs >/dev/null 2>&1 && echo reachable || echo denied at-read; else echo denied at-mount; fi; exit 0'"`,
  // Per dataset, because the strongest route is specific. Root enumerates the children; the worker may not.
  `for sealed_child in ${TRAINING_SEALED_INPUTS_ROOT}/*; do`,
  '  test -e "$sealed_child" || continue',
  `  seal_route "direct-read $sealed_child" "$(seal_worker "if ls -1 '$sealed_child' >/dev/null 2>&1 || cat '$sealed_child'/* >/dev/null 2>&1; then echo reachable; else echo denied at-read; fi")"`,
  `  seal_ns_route "namespace-rebind $sealed_child" "unshare --user --map-root-user --mount -- /bin/sh -c 'mkdir -p ${privateTmp}/seal-child 2>/dev/null || { echo unknown private-tmp-unwritable; exit 0; }; if mount --bind \\"$sealed_child\\" ${privateTmp}/seal-child 2>/dev/null; then ls -1 ${privateTmp}/seal-child >/dev/null 2>&1 && echo reachable || echo denied at-read; else echo denied at-mount; fi; exit 0'"`,
  "done",
  // A Spawnfile-owned attestation beside the slot receipt, readable by the organization uid. The
  // cross-repo `noopolis.daimon.grok-slot-preflight.v2` canary shape is deliberately untouched — its
  // schema lives in Daimon and no consumer here can validate an added member — so the per-route
  // mechanism is recorded here rather than implied by a bare `result: "denied"` there.
  `seal_attestation=${quote(trainingSlotPaths(workerUid - trainingSlotPaths(0).workerUid).sealedInputsAttestation)}`,
  `printf '{"version":"spawnfile.training-sealed-inputs.v1","root":"%s","worker_uid":%s,"identity":"%s","pinned_seccomp_profile_sha256":"%s","namespace_routes":"%s","routes":[%s]}\\n' `
    + `${quote(TRAINING_SEALED_INPUTS_ROOT)} ${workerUid} `
    + `"$(stat -c '%u:%g %a' ${quote(TRAINING_SEALED_INPUTS_ROOT)})" ${quote(DAIMON_GROK_SECCOMP_PROFILE_SHA256)} `
    + '"$seal_namespace" "$seal_rows" > "$seal_attestation.tmp"',
  'chown 0:0 "$seal_attestation.tmp"; chmod 0640 "$seal_attestation.tmp"; chown 0:' + String(DAIMON_ORGANIZATION_UID) + ' "$seal_attestation.tmp"',
  'mv "$seal_attestation.tmp" "$seal_attestation"',
  'echo "sealed inputs attestation written to $seal_attestation"'
];

/** Where the broker's own `service.json` lands, so the supervisor can prove the slot it restarted is the slot it provisioned. */
export const TRAINING_SERVICE_CONFIG_PATH = DAIMON_GROK_ENGINE_BROKER.serviceConfigPath;
export const TRAINING_REGISTRATION_PATH = DAIMON_GROK_ENGINE_BROKER.registrationPath;
export const TRAINING_BROKER_CONTROL_ROOT = path.posix.dirname(DAIMON_GROK_ENGINE_BROKER.controlSocketPath);
