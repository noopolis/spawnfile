import path from "node:path";

import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import type { EntrypointOptions } from "./containerEntrypointRender.js";
import {
  DAIMON_RUNTIME_ACCEPTANCE_STORE_MOUNT_ID,
  DAIMON_WAKE_FUSE_DIRECTORY
} from "../runtime/daimon/config.js";
import { DAIMON_GROK_TURN_USAGE_LEDGER } from "../runtime/daimon/contractManifest.js";
import { MOLTNET_READINESS_DIRECTORY } from "./containerReadinessPaths.js";
import {
  renderDaimonOwnershipProgram,
  resolveDaimonVolumeIdentityFiles
} from "./containerDaimonOwnershipGuardRender.js";
export { resolveDaimonVolumeIdentityFiles } from "./containerDaimonOwnershipGuardRender.js";
import {
  DAIMON_BROKER_EXECUTABLE,
  DAIMON_BROKER_BACKEND_SOCKET,
  DAIMON_BROKER_LAUNCHER_SOCKET,
  DAIMON_BROKER_REALM,
  DAIMON_BROKER_SOCKET,
  DAIMON_BROKER_UID,
  DAIMON_ORGANIZATION_UID,
  renderDaimonBrokerProvisioning,
  renderDaimonUsageLedgerProvisioning,
  resolveDaimonGrokRegistrations
} from "./containerDaimonBrokerRender.js";

export const DAIMON_AUTHORIZED_UID_ENV = "SPAWNFILE_DAIMON_AUTHORIZED_UID";
export const DAIMON_RUNTIME_UID = DAIMON_ORGANIZATION_UID;
export const DAIMON_UID_ENTRYPOINT_PATH = "/opt/spawnfile/daimon-uid-entrypoint.sh";
export const DAIMON_RUNTIME_HOMES_DIRECTORY = "runtime-homes";
export const DAIMON_BROKER_STARTUP_TIMEOUT_SECONDS = 60;

export const renderDaimonBrokerSocketWait = (
  timeoutSeconds = DAIMON_BROKER_STARTUP_TIMEOUT_SECONDS,
  pollSeconds = 0.1
): string[] => [
  `broker_startup_timeout_seconds=${timeoutSeconds}`,
  `broker_startup_poll_seconds=${pollSeconds}`,
  "broker_startup_started=$SECONDS",
  "broker_process_status_root=/proc",
  "wait_for_broker_socket() {",
  "  socket=$1; child=$2; label=$3",
  "  while [ ! -S \"$socket\" ]; do",
  "    if ! kill -0 \"$child\" 2>/dev/null; then set +e; wait \"$child\"; child_status=$?; set -e; echo \"$label exited before readiness (status $child_status)\" >&2; return 1; fi",
  "    if [ $((SECONDS - broker_startup_started)) -ge \"$broker_startup_timeout_seconds\" ]; then echo \"$label readiness timed out after ${broker_startup_timeout_seconds}s\" >&2; return 1; fi",
  "    sleep \"$broker_startup_poll_seconds\"",
  "  done",
  "}",
  "wait_for_broker_identity() {",
  "  child=$1; expected_uid=$2; expected_caps=$3; label=$4",
  "  while kill -0 \"$child\" 2>/dev/null; do",
  "    status_path=$broker_process_status_root/$child/status",
  "    observed_uid=$(awk '/^Uid:/{print $2}' \"$status_path\" 2>/dev/null || true)",
  "    observed_caps=$(awk '/^CapBnd:/{print $2}' \"$status_path\" 2>/dev/null || true)",
  "    if [ \"$observed_uid\" = \"$expected_uid\" ] && [ \"$observed_caps\" = \"$expected_caps\" ]; then return 0; fi",
  "    if [ $((SECONDS - broker_startup_started)) -ge \"$broker_startup_timeout_seconds\" ]; then echo \"$label identity readiness timed out after ${broker_startup_timeout_seconds}s\" >&2; return 1; fi",
  "    sleep \"$broker_startup_poll_seconds\"",
  "  done",
  "  set +e; wait \"$child\"; child_status=$?; set -e; echo \"$label exited before identity readiness (status $child_status)\" >&2; return 1",
  "}"
];

const SPAWNFILE_PRIVATE_STATE_ROOT = "/var/lib/spawnfile";
/**
 * `/var/lib/spawnfile/daimon` hosts several independently-owned children —
 * the AGY/Grok subscription realms (organization uid), the broker realm and
 * usage ledger (broker uid, or broker:organization), the wake fuse
 * (organization uid) — so it must stay a shared, root-owned, universally
 * traversable ancestor (0711), exactly like `SPAWNFILE_PRIVATE_STATE_ROOT`
 * itself, never chowned to the organization uid. Before this exclusion, any
 * organization with an AGY agent (whose realm mount lives here and is not
 * itself excluded from the ancestor walk below) got this directory chowned
 * to the organization uid as a side effect of securing that one mount —
 * which then made every *other* child that must be provisioned here as a
 * different uid (most concretely, the usage ledger provisioned unconditionally
 * by `renderDaimonUsageLedgerProvisioning`) fail to be created at all, because
 * the entrypoint runs that provisioning as root without `CAP_DAC_OVERRIDE`
 * (`runProject.ts`'s capability set), which cannot write into a directory it
 * does not own by matching uid or gid.
 */
const DAIMON_SHARED_STATE_ROOT = `${SPAWNFILE_PRIVATE_STATE_ROOT}/daimon`;
const DAIMON_AGY_SUBSCRIPTION_REALM_MOUNT_ID = "daimon-agy-subscription-realm";
const DAIMON_AGY_RUNTIME_HOME_MOUNT_ID_PREFIX = "daimon-agy-runtime-home-";
const DAIMON_PORTABLE_ENGINE_HOME_MOUNT_ID_PREFIX = "daimon-engine-home-";

const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

const nodeSlug = (nodeId: string): string =>
  nodeId.replace(/^agent:/u, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const opaqueMountTargets = (runtimePlans: RuntimeTargetPlan[]): string[] =>
  [...new Set(runtimePlans
    .filter((plan) => plan.runtimeName === "daimon")
    .flatMap((plan) => [
      ...(plan.opaqueMountTargets ?? []),
      ...(plan.resources ?? []).map((resource) => resource.linkPath),
      ...Object.entries(plan.engineByNodeId ?? {})
        .filter(([, engine]) => engine === "codex")
        .map(([nodeId, engine]) => path.posix.join(
          plan.instancePaths.instanceRoot ?? "", DAIMON_RUNTIME_HOMES_DIRECTORY,
          nodeSlug(nodeId), ".daimon-inbound", `${engine}-auth`
        ))
    ])
    .filter((target) => target.startsWith("/"))
  )].sort();

export const resolveDaimonUidEntrypointStateRoots = (
  runtimePlans: RuntimeTargetPlan[]
): string[] => [
  ...new Set([
    ...runtimePlans.flatMap((plan) => [
      plan.instancePaths.workspacePath,
      ...(plan.instancePaths.homePath ? [plan.instancePaths.homePath] : []),
      ...(plan.runtimeName === "daimon" && plan.instancePaths.instanceRoot
        ? [path.posix.join(plan.instancePaths.instanceRoot, DAIMON_RUNTIME_HOMES_DIRECTORY)]
        : [])
    ])
  ])
].filter((root) => root.startsWith("/")).sort();

const writableStateRoots = (
  runtimePlans: RuntimeTargetPlan[],
  persistentMountPaths: string[]
): string[] => [
  ...new Set([
    ...resolveDaimonUidEntrypointStateRoots(runtimePlans),
    ...persistentMountPaths
  ])
].filter((root) => root.startsWith("/")
  && root !== DAIMON_BROKER_REALM
  && root !== DAIMON_GROK_TURN_USAGE_LEDGER.directoryPath
  && root !== DAIMON_WAKE_FUSE_DIRECTORY).sort();

const privateDirectoriesThrough = (target: string): string[] => {
  if (
    target !== SPAWNFILE_PRIVATE_STATE_ROOT &&
    !target.startsWith(`${SPAWNFILE_PRIVATE_STATE_ROOT}/`)
  ) return [];
  const relative = path.posix.relative(SPAWNFILE_PRIVATE_STATE_ROOT, target);
  const segments = relative === "" ? [] : relative.split("/");
  return [
    SPAWNFILE_PRIVATE_STATE_ROOT,
    ...segments.map((_, index) =>
      path.posix.join(SPAWNFILE_PRIVATE_STATE_ROOT, ...segments.slice(0, index + 1))
    )
  ];
};

const privateModeDirectories = (runtimePlans: RuntimeTargetPlan[], moltnet?: EntrypointOptions["moltnet"]): string[] => [
  ...new Set(runtimePlans
    .filter((plan) => plan.runtimeName === "daimon")
    .flatMap((plan) => plan.persistentMounts ?? [])
    .filter((mount) => mount.id === DAIMON_RUNTIME_ACCEPTANCE_STORE_MOUNT_ID
      || mount.id === DAIMON_AGY_SUBSCRIPTION_REALM_MOUNT_ID
      || mount.id.startsWith(DAIMON_AGY_RUNTIME_HOME_MOUNT_ID_PREFIX)
      || mount.id.startsWith(DAIMON_PORTABLE_ENGINE_HOME_MOUNT_ID_PREFIX))
    .map((mount) => mount.mount_path)
    .filter((target) => target.startsWith("/"))
    .concat((moltnet?.nodePlans ?? []).flatMap((plan) =>
      plan.receiptStorePath ? [path.posix.dirname(plan.receiptStorePath)] : []
    )))
].sort();

const portableEngineHomeDirectories = (
  runtimePlans: RuntimeTargetPlan[]
): string[] => [
  ...new Set(runtimePlans
    .filter((plan) => plan.runtimeName === "daimon")
    .flatMap((plan) => plan.persistentMounts ?? [])
    .filter((mount) => mount.id.startsWith(DAIMON_PORTABLE_ENGINE_HOME_MOUNT_ID_PREFIX))
    .map((mount) => mount.mount_path)
    .filter((target) => target.startsWith("/")))
].sort();

const moltnetConfigPaths = (
  moltnet: EntrypointOptions["moltnet"]
): string[] => {
  if (!moltnet) return [];
  return [
    ...moltnet.serverPlans.flatMap((plan) =>
      plan.mode === "managed" && plan.configPath ? [plan.configPath] : []
    ),
    ...moltnet.nodePlans.map((plan) => plan.configPath)
  ].filter((configPath) => configPath.startsWith("/")).sort();
};

const daimonConfigPaths = (runtimePlans: RuntimeTargetPlan[]): string[] => [
  ...new Set(runtimePlans
    .filter((plan) => plan.runtimeName === "daimon")
    .map((plan) => plan.instancePaths.configPath)
    .filter((configPath) => configPath.startsWith("/")))
].sort();

const moltnetReceiptDirectories = (moltnet: EntrypointOptions["moltnet"]): string[] =>
  [...new Set((moltnet?.nodePlans ?? []).flatMap((plan) =>
    plan.receiptStorePath ? [path.posix.dirname(plan.receiptStorePath)] : []
  ))].filter((directory) => directory.startsWith("/")).sort();

export interface DaimonUidEntrypointOwnershipPlan {
  creatablePrivateDirectories: Array<{ anchor: string; target: string }>;
  opaqueDescendantRoots: string[];
  privateDirectories: string[];
  privateFiles: string[];
  privateModeDirectories: string[];
  stateRoots: string[];
}

export const resolveDaimonUidEntrypointOwnershipPlan = (
  runtimePlans: RuntimeTargetPlan[],
  persistentMountPaths: string[] = [],
  moltnet?: EntrypointOptions["moltnet"]
): DaimonUidEntrypointOwnershipPlan => {
  const opaqueDescendantRoots = portableEngineHomeDirectories(runtimePlans);
  const stateRoots = writableStateRoots(runtimePlans, persistentMountPaths)
    .filter((root) => !opaqueDescendantRoots.some((opaqueRoot) =>
      root === opaqueRoot || root.startsWith(`${opaqueRoot}/`)
    ));
  const privateFiles = [
    ...new Set([...daimonConfigPaths(runtimePlans), ...moltnetConfigPaths(moltnet)])
  ].sort();
  const modeDirectories = [
    ...new Set([
      ...privateModeDirectories(runtimePlans, moltnet),
      ...daimonConfigPaths(runtimePlans).map((configPath) => path.posix.dirname(configPath))
    ])
  ].sort();
  const receiptDirectories = moltnetReceiptDirectories(moltnet);
  const creatableTargets = [
    ...receiptDirectories,
    ...((moltnet?.nodePlans.length ?? 0) > 0 ? [MOLTNET_READINESS_DIRECTORY] : [])
  ];
  const privateDirectories = [
    ...new Set([
      ...stateRoots.flatMap(privateDirectoriesThrough),
      ...moltnetReceiptDirectories(moltnet).flatMap(privateDirectoriesThrough),
      ...privateFiles.flatMap((configPath) =>
        privateDirectoriesThrough(path.posix.dirname(configPath))
      )
    ])
  ].filter((directory) => directory !== SPAWNFILE_PRIVATE_STATE_ROOT && directory !== DAIMON_SHARED_STATE_ROOT).sort();
  return {
    creatablePrivateDirectories: creatableTargets.map((target) => ({
      anchor: target === MOLTNET_READINESS_DIRECTORY
        ? "/run"
        : stateRoots.filter((root) => target === root || target.startsWith(`${root}/`))
          .sort((left, right) => right.length - left.length)[0] ?? SPAWNFILE_PRIVATE_STATE_ROOT,
      target
    })),
    opaqueDescendantRoots,
    privateDirectories,
    privateFiles,
    privateModeDirectories: modeDirectories,
    stateRoots
  };
};

export const renderDaimonUidEntrypoint = (
  runtimePlans: RuntimeTargetPlan[],
  persistentMountPaths: string[] = [],
  moltnet?: EntrypointOptions["moltnet"]
): string => {
  const opaqueTargets = opaqueMountTargets(runtimePlans);
  const daimonPlan = runtimePlans.find((plan) => plan.runtimeName === "daimon");
  const daimonConfigPath = daimonPlan?.instancePaths.configPath;
  const daimonStartPath = daimonPlan
    ? path.posix.join(daimonPlan.runtimeRoot, "daimon-start.sh")
    : "";
  const ownershipPlan = resolveDaimonUidEntrypointOwnershipPlan(
    runtimePlans,
    persistentMountPaths,
    moltnet
  );
  const immutableRuntimeRoots = [
    ...new Set(runtimePlans
      .filter((plan) => plan.runtimeName === "daimon")
      .map((plan) => plan.runtimeRoot)
      .filter((runtimeRoot) => runtimeRoot.startsWith("/opt/spawnfile/runtime-installs/")))
  ].sort();
  const volumeIdentityFiles = resolveDaimonVolumeIdentityFiles(runtimePlans);
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `uid=${DAIMON_ORGANIZATION_UID}`,
    'gid="$uid"',
    `runtime_command=(${quote("/opt/spawnfile/entrypoint.sh")} --spawnfile-runtime-identity "$uid" "$gid")`,
    'if [ "$#" -gt 0 ]; then',
    `  if [ "$#" -ne 5 ] || [ "$1" != auth ] || [ "$2" != agy ] || [ "$3" != login ] || [ "$4" != --config ] || [ "$5" != ${quote(daimonConfigPath ?? "")} ]; then echo "Unsupported Daimon container command" >&2; exit 1; fi`,
    `  runtime_command=(bash ${quote(daimonStartPath)} "$@")`,
    "fi",
    `state_roots=(${ownershipPlan.stateRoots.map(quote).join(" ")})`,
    "node - \"$uid\" \"${state_roots[@]}\" <<'SPAWNFILE_DAIMON_OWNERSHIP'",
    renderDaimonOwnershipProgram(
      opaqueTargets,
      ownershipPlan.opaqueDescendantRoots,
      immutableRuntimeRoots,
      volumeIdentityFiles,
      ownershipPlan.privateDirectories,
      ownershipPlan.privateFiles,
      ownershipPlan.privateModeDirectories,
      ownershipPlan.creatablePrivateDirectories
    ),
    "SPAWNFILE_DAIMON_OWNERSHIP",
    `for fixed_uid in ${DAIMON_ORGANIZATION_UID} ${DAIMON_BROKER_UID} ${resolveDaimonGrokRegistrations(runtimePlans).map((entry) => entry.uid).join(" ")}; do`,
    '  if ! getent group "$fixed_uid" >/dev/null; then groupadd -K GID_MIN=1 --gid "$fixed_uid" "daimon-$fixed_uid"; fi',
    '  if ! getent passwd "$fixed_uid" >/dev/null; then useradd -K UID_MIN=1 --no-create-home --no-log-init --uid "$fixed_uid" --gid "$fixed_uid" --home-dir /nonexistent --shell /usr/sbin/nologin "daimon-$fixed_uid"; fi',
    "done",
    ...renderDaimonBrokerProvisioning(runtimePlans),
    'if ! getent passwd "$uid" >/dev/null; then',
    '  runtime_identity="daimon-$uid"',
    '  runtime_group="$(getent group "$gid" | cut -d: -f1 || true)"',
    '  if [ -z "$runtime_group" ]; then groupadd -K GID_MIN=1 --gid "$gid" "$runtime_identity"; runtime_group="$runtime_identity"; fi',
    '  useradd -K UID_MIN=1 --no-create-home --no-log-init --uid "$uid" --gid "$gid" --home-dir /nonexistent --shell /usr/sbin/nologin "$runtime_identity"',
    'fi',
    'if ! getent passwd "$uid" >/dev/null; then echo "Daimon authorized UID has no local identity" >&2; exit 1; fi',
    `chown 0:0 ${quote(DAIMON_WAKE_FUSE_DIRECTORY)} && chmod 0700 ${quote(DAIMON_WAKE_FUSE_DIRECTORY)} && chown ${DAIMON_ORGANIZATION_UID}:${DAIMON_ORGANIZATION_UID} ${quote(DAIMON_WAKE_FUSE_DIRECTORY)}`,
    // Unconditional: AGY and Codex write the per-turn usage ledger from the
    // organization-uid runtime process below, not the (Grok-only) broker, so
    // this cannot be gated on `resolveDaimonGrokRegistrations`.
    ...renderDaimonUsageLedgerProvisioning(),
    ...(resolveDaimonGrokRegistrations(runtimePlans).length === 0 ? [] : [
      ...renderDaimonBrokerSocketWait(),
      "startup_children=()",
      "cleanup_broker_startup() { status=$?; trap - EXIT; for child in \"${startup_children[@]}\"; do kill -TERM \"$child\" 2>/dev/null || true; wait \"$child\" 2>/dev/null || true; done; return \"$status\"; }",
      "trap cleanup_broker_startup EXIT",
      "trap 'exit 143' TERM INT HUP",
      `install -d -o ${DAIMON_BROKER_UID} -g ${DAIMON_BROKER_UID} -m 0700 ${quote(DAIMON_BROKER_REALM)}`,
      `if [ -e ${quote(`${DAIMON_BROKER_REALM}/auth.json`)} ]; then test -f ${quote(`${DAIMON_BROKER_REALM}/auth.json`)} && test ! -L ${quote(`${DAIMON_BROKER_REALM}/auth.json`)}; chown 0:0 ${quote(`${DAIMON_BROKER_REALM}/auth.json`)}; chmod 0600 ${quote(`${DAIMON_BROKER_REALM}/auth.json`)}; chown ${DAIMON_BROKER_UID}:${DAIMON_BROKER_UID} ${quote(`${DAIMON_BROKER_REALM}/auth.json`)}; fi`,
      `setpriv --clear-groups --reuid ${DAIMON_BROKER_UID} --regid ${DAIMON_BROKER_UID} --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- bash -ceu 'probe=${DAIMON_BROKER_REALM}/.daimon-ancestry-probe; umask 077; : > "$probe"; rm "$probe"'`,
      `setpriv --clear-groups --reuid ${DAIMON_ORGANIZATION_UID} --regid ${DAIMON_ORGANIZATION_UID} --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- bash -ceu '! test -r ${DAIMON_BROKER_REALM}'`,
      ...resolveDaimonGrokRegistrations(runtimePlans).map((entry) =>
        `setpriv --clear-groups --reuid ${entry.uid} --regid ${entry.uid} --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- bash -ceu '! test -r ${DAIMON_BROKER_REALM}'`
      ),
      `setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all,+chown,+setuid,+setgid -- ${quote(DAIMON_BROKER_EXECUTABLE)} &`,
      "launcher_pid=$!",
      "startup_children+=(\"$launcher_pid\")",
      `wait_for_broker_socket ${quote(DAIMON_BROKER_LAUNCHER_SOCKET)} "$launcher_pid" "engine broker launcher"`,
      `wait_for_broker_identity "$launcher_pid" 0 00000000000000c1 "engine broker launcher"`,
      `setpriv --clear-groups --reuid ${DAIMON_BROKER_UID} --regid ${DAIMON_BROKER_UID} --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- ${quote(path.posix.join(daimonPlan?.runtimeRoot ?? "", "bin/daimon-runtime"))} engine-broker serve &`,
      "broker_pid=$!",
      "startup_children+=(\"$broker_pid\")",
      `wait_for_broker_socket ${quote(DAIMON_BROKER_BACKEND_SOCKET)} "$broker_pid" "engine broker backend"`,
      `wait_for_broker_identity "$broker_pid" ${DAIMON_BROKER_UID} 0000000000000000 "engine broker backend"`,
      `setpriv --inh-caps=-all --ambient-caps=-all --bounding-set=-all,+chown,+setuid,+setgid,+setpcap -- ${quote(DAIMON_BROKER_EXECUTABLE)} --relay &`,
      "relay_pid=$!",
      "startup_children+=(\"$relay_pid\")",
      `wait_for_broker_socket ${quote(DAIMON_BROKER_SOCKET)} "$relay_pid" "engine broker control relay"`,
      `wait_for_broker_identity "$relay_pid" ${DAIMON_BROKER_UID} 0000000000000000 "engine broker control relay"`,
      `[ -S ${quote(DAIMON_BROKER_SOCKET)} ] || exit 1`,
      "for child_spec in \"$launcher_pid:0:00000000000000c1\" \"$relay_pid:2100:0000000000000000\" \"$broker_pid:2100:0000000000000000\"; do child=${child_spec%%:*}; rest=${child_spec#*:}; expected_uid=${rest%%:*}; expected_caps=${rest##*:}; observed_uid=$(awk '/^Uid:/{print $2}' \"/proc/$child/status\"); cap_bnd=$(awk '/^CapBnd:/{print $2}' \"/proc/$child/status\"); [ \"$observed_uid\" = \"$expected_uid\" ] && [ \"$cap_bnd\" = \"$expected_caps\" ] || exit 1; done"
    ]),
    "setpriv --clear-groups --reuid \"$uid\" --regid \"$gid\" --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- bash -ceu '",
    "  if [ \"$EUID\" -eq 0 ]; then exit 1; fi",
    "  test \"$(sed -n \"s/^CapEff:[[:space:]]*//p\" /proc/self/status)\" = 0000000000000000",
    "  exec \"$@\"",
    `' bash "\${runtime_command[@]}" &`,
    "runtime_pid=$!",
    "trap - EXIT TERM INT HUP",
    "stopping=0",
    "stop_children() { stopping=1; kill -TERM \"$runtime_pid\" 2>/dev/null || true; for child in \"${relay_pid:-}\" \"${broker_pid:-}\" \"${launcher_pid:-}\"; do [ -z \"$child\" ] || kill -TERM \"$child\" 2>/dev/null || true; done; }",
    "trap stop_children TERM INT HUP",
    'watch_pids=("$runtime_pid")',
    ...(resolveDaimonGrokRegistrations(runtimePlans).length === 0 ? [] : ['watch_pids+=("$relay_pid" "$broker_pid" "$launcher_pid")']),
    "finished_pid=",
    'set +e; wait -n -p finished_pid "${watch_pids[@]}"; status=$?; set -e',
    'if [ "${finished_pid:-}" != "$runtime_pid" ]; then status=1; fi',
    'kill -TERM "$runtime_pid" 2>/dev/null || true',
    "for child in \"${relay_pid:-}\" \"${broker_pid:-}\" \"${launcher_pid:-}\"; do [ -z \"$child\" ] || { kill -TERM \"$child\" 2>/dev/null || true; wait \"$child\" 2>/dev/null || true; }; done",
    'wait "$runtime_pid" 2>/dev/null || true',
    "exit \"$status\""
  ].join("\n") + "\n";
};
