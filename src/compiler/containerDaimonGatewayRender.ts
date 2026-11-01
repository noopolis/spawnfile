import path from "node:path";

import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import {
  DAIMON_GATEWAY_BOOTSTRAP_ROOT,
  DAIMON_GATEWAY_CONFIG,
  DAIMON_GATEWAY_ETC,
  DAIMON_GATEWAY_KEY_ENV,
  DAIMON_GATEWAY_KEY_TABLE,
  DAIMON_GATEWAY_KEY_TABLE_VERSION,
  DAIMON_GATEWAY_PORT,
  DAIMON_GATEWAY_PRINCIPAL,
  DAIMON_GATEWAY_RUN,
  DAIMON_GATEWAY_URL,
  DAIMON_GATEWAY_URL_ENV,
  DAIMON_GATEWAY_HOST,
  type DaimonGatewayedDescriptor,
  daimonGatewayBootstrapCopyPath,
  daimonGatewayBootstrapMountPath,
  daimonGatewayedEngines,
  daimonGatewayRealmPath,
  daimonGatewayRefreshScratchPath,
  renderDaimonGatewayConfig
} from "../runtime/daimon/gateway.js";
import { DAIMON_BROKER_UID, DAIMON_GATEWAY_UID, DAIMON_ORGANIZATION_UID } from "../runtime/daimon/runtimeIdentity.js";

export { DAIMON_GATEWAY_UID };
export const DAIMON_GATEWAY_STARTUP_TIMEOUT_SECONDS = 60;
/** Root-shell variable holding this start's key; never exported, passed only to the runtime launch. */
const KEY_VARIABLE = "daimon_gateway_key";
/** Root-shell variable holding the gateway URL this start hands the runtime. */
const URL_VARIABLE = "daimon_gateway_url";
/** `1` when an external gateway was supplied at boot. */
const EXTERNAL_VARIABLE = "daimon_gateway_external";
const drop = (uid: number): string =>
  `setpriv --clear-groups --reuid ${uid} --regid ${uid} --inh-caps=-all --ambient-caps=-all --bounding-set=-all --`;

/** Gatewayed engines this container's Daimon organization runs; empty means no gateway. */
export const resolveDaimonGatewayEngines = (plans: readonly RuntimeTargetPlan[]) =>
  daimonGatewayedEngines(plans.filter((plan) => plan.runtimeName === "daimon")
    .flatMap((plan) => Object.values(plan.engineByNodeId ?? {})));

/** Persistent realm volumes the gateway, not the organization uid, owns. */
export const resolveDaimonGatewayRealmPaths = (plans: readonly RuntimeTargetPlan[]): string[] =>
  resolveDaimonGatewayEngines(plans).map(daimonGatewayRealmPath);

/**
 * Root provisioning of the gateway's private state, before any engine process
 * starts: the digest-only key table and config under `root:<gateway> 0440`,
 * each realm re-owned to the gateway uid at `0700`, and a gateway-owned copy of
 * each bootstrap leaf, whose bind mount sits under a root-only directory the
 * organization uid cannot reach. Reads the key from `$daimon_gateway_key`.
 * Root holds `CAP_CHOWN` and `CAP_DAC_READ_SEARCH` but not `CAP_FOWNER`, so
 * every chmod happens while root owns the path. Shared by the in-container
 * placement and the training sidecar (`host` is the only difference).
 */
export const renderDaimonGatewayStateProvisioning = (descriptors: readonly DaimonGatewayedDescriptor[], host = DAIMON_GATEWAY_HOST): string[] => {
  const realms = descriptors.map((descriptor) => ({
    bootstrap: daimonGatewayBootstrapMountPath(descriptor.auth.realm),
    copy: daimonGatewayBootstrapCopyPath(descriptor.auth.realm),
    durable: daimonGatewayRealmPath(descriptor),
    maxBytes: descriptor.auth.realm.maxCredentialBytes,
    scratch: daimonGatewayRefreshScratchPath(descriptor) ?? null
  }));
  const program = [
    "const crypto = require('node:crypto'); const fs = require('node:fs'); const { constants } = fs;",
    `const gateway = ${DAIMON_GATEWAY_UID}; const realms = ${JSON.stringify(realms)};`,
    `const key = process.env.SPAWNFILE_DAIMON_GATEWAY_KEY ?? ''; if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('gateway key generation failed');`,
    "const privateWrite = (target, bytes, mode, uid, gid) => { const fd = fs.openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { let written = 0; while (written < bytes.length) written += fs.writeSync(fd, bytes, written, bytes.length - written, written); fs.fchmodSync(fd, mode); fs.fchownSync(fd, uid, gid); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };",
    `const table = { version: '${DAIMON_GATEWAY_KEY_TABLE_VERSION}', keys: { [crypto.createHash('sha256').update(key, 'utf8').digest('hex')]: { agent_id: '${DAIMON_GATEWAY_PRINCIPAL}', engines: ${JSON.stringify(descriptors.map(({ id }) => id))} } } };`,
    `privateWrite('${DAIMON_GATEWAY_KEY_TABLE}', Buffer.from(JSON.stringify(table) + '\\n'), 0o440, 0, gateway);`,
    `privateWrite('${DAIMON_GATEWAY_CONFIG}', Buffer.from(${JSON.stringify(renderDaimonGatewayConfig(descriptors, host))}), 0o440, 0, gateway);`,
    "for (const realm of realms) {",
    "  const info = fs.lstatSync(realm.durable); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('gateway realm is not a directory');",
    "  fs.chownSync(realm.durable, 0, 0); fs.chmodSync(realm.durable, 0o700);",
    // Re-own the whole tree: a migrated broker realm also holds its legacy journal and turn directories.
    "  const reown = (target) => { for (const name of fs.readdirSync(target)) { const entry = `${target}/${name}`, stat = fs.lstatSync(entry); if (stat.isDirectory()) { fs.chownSync(entry, 0, 0); fs.chmodSync(entry, stat.mode & 0o700); reown(entry); } else if (!stat.isFile() || stat.nlink !== 1) throw new Error('gateway realm holds an unsafe entry'); else { fs.chownSync(entry, 0, 0); fs.chmodSync(entry, stat.mode & 0o700); } fs.chownSync(entry, gateway, gateway); } };",
    "  reown(realm.durable); fs.chownSync(realm.durable, gateway, gateway);",
    "  if (realm.scratch !== null) { fs.mkdirSync(realm.scratch, { mode: 0o700 }); fs.chownSync(realm.scratch, gateway, gateway); }",
    "  let source; try { source = fs.lstatSync(realm.bootstrap); } catch (error) { if (error.code !== 'ENOENT') throw error; }",
    "  if (source === undefined) continue;",
    "  if (!source.isFile() || source.size < 2 || source.size > realm.maxBytes) throw new Error('gateway bootstrap leaf is unsafe');",
    "  const fd = fs.openSync(realm.bootstrap, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); let bytes; try { const opened = fs.fstatSync(fd); if (opened.dev !== source.dev || opened.ino !== source.ino) throw new Error('gateway bootstrap leaf changed'); bytes = fs.readFileSync(fd); } finally { fs.closeSync(fd); }",
    "  try { privateWrite(realm.copy, bytes, 0o600, gateway, gateway); } finally { bytes.fill(0); }",
    "}"
  ].join("\n");
  return [
    `if [ -d ${DAIMON_GATEWAY_ETC} ]; then chmod u+rwx ${DAIMON_GATEWAY_ETC}; fi`,
    `if [ -d ${DAIMON_GATEWAY_RUN} ]; then chmod u+rwx ${DAIMON_GATEWAY_RUN}; fi`,
    `rm -rf ${DAIMON_GATEWAY_ETC} ${DAIMON_GATEWAY_RUN}`,
    `install -d -o root -g root -m 0700 ${DAIMON_GATEWAY_ETC} ${DAIMON_GATEWAY_RUN}`,
    `if [ ! -d ${DAIMON_GATEWAY_BOOTSTRAP_ROOT} ]; then install -d -o root -g root -m 0700 ${DAIMON_GATEWAY_BOOTSTRAP_ROOT}; fi`,
    `test -d ${DAIMON_GATEWAY_BOOTSTRAP_ROOT} && test ! -L ${DAIMON_GATEWAY_BOOTSTRAP_ROOT}`,
    `chown 0:0 ${DAIMON_GATEWAY_BOOTSTRAP_ROOT} && chmod 0700 ${DAIMON_GATEWAY_BOOTSTRAP_ROOT}`,
    `SPAWNFILE_DAIMON_GATEWAY_KEY="$${KEY_VARIABLE}" node <<'SPAWNFILE_DAIMON_GATEWAY_PROVISION'`,
    program,
    "SPAWNFILE_DAIMON_GATEWAY_PROVISION",
    `chmod 0750 ${DAIMON_GATEWAY_ETC} ${DAIMON_GATEWAY_RUN} && chown 0:${DAIMON_GATEWAY_UID} ${DAIMON_GATEWAY_ETC} ${DAIMON_GATEWAY_RUN}`
  ];
};

/**
 * The organization's gateway placement, decided at boot. With
 * `DAIMON_GATEWAY_URL` (and its key) in the container environment, an external
 * gateway (the training sidecar) serves this organization: nothing is
 * provisioned, no gateway starts and no realm is mounted. Otherwise root
 * generates a fresh 32-byte key per start (so no key exists in the image or the
 * compile output) and provisions the in-container gateway. Either way the
 * runtime gets the same two variables: one agent contract.
 */
export const renderDaimonGatewayProvisioning = (plans: readonly RuntimeTargetPlan[]): string[] => {
  const descriptors = resolveDaimonGatewayEngines(plans);
  if (descriptors.length === 0) return [];
  return [
    `if [ -n "\${${DAIMON_GATEWAY_URL_ENV}:-}" ]; then`,
    `  ${EXTERNAL_VARIABLE}=1 ${URL_VARIABLE}=$${DAIMON_GATEWAY_URL_ENV}`,
    `  ${KEY_VARIABLE}=\${${DAIMON_GATEWAY_KEY_ENV}:?${DAIMON_GATEWAY_KEY_ENV} must accompany ${DAIMON_GATEWAY_URL_ENV}}`,
    // Only the runtime and broker launches below get them, as with the in-container gateway.
    `  export -n ${DAIMON_GATEWAY_URL_ENV} ${DAIMON_GATEWAY_KEY_ENV}`,
    // Empty root-only placeholders: a brokered worker's sandbox masks these paths and refuses one that is missing.
    ...(descriptors.some((descriptor) => descriptor.broker !== null)
      ? [DAIMON_GATEWAY_ETC, DAIMON_GATEWAY_RUN, DAIMON_GATEWAY_BOOTSTRAP_ROOT, ...descriptors.map(daimonGatewayRealmPath)] : [])
      .map((target) => `  if [ ! -e ${target} ]; then install -d -o root -g root -m 0700 ${target}; fi`),
    "else",
    `  ${EXTERNAL_VARIABLE}=0 ${URL_VARIABLE}=${DAIMON_GATEWAY_URL}`,
    // Rotated every start: 32 random bytes as lowercase hex, held only in this root shell.
    `  ${KEY_VARIABLE}=$(od -An -vtx1 -N32 /dev/urandom | tr -d ' \\n')`,
    ...renderDaimonGatewayStateProvisioning(descriptors),
    "fi"
  ];
};

/**
 * Starts the gateway as its own uid with no capabilities, after proving the
 * organization uid (and a broker uid) cannot read any gateway-held path, then waits for its uid,
 * bounding set and loopback port. Uses the shared startup supervision helpers.
 */
export const renderDaimonGatewayLaunch = (plans: readonly RuntimeTargetPlan[], runtimeRoot: string): string[] => {
  const descriptors = resolveDaimonGatewayEngines(plans);
  if (descriptors.length === 0) return [];
  const realmPaths = descriptors.map(daimonGatewayRealmPath);
  const hidden = [...realmPaths, DAIMON_GATEWAY_BOOTSTRAP_ROOT, DAIMON_GATEWAY_ETC, DAIMON_GATEWAY_RUN];
  // Neither the organization uid nor a broker (which reaches the gateway only by key) may read the login.
  const outsiders = [DAIMON_ORGANIZATION_UID, ...(descriptors.some((descriptor) => descriptor.broker !== null) ? [DAIMON_BROKER_UID] : [])];
  return [
    `if [ "$${EXTERNAL_VARIABLE}" = 0 ]; then`,
    ...outsiders.flatMap((uid) => hidden.map((target) => `${drop(uid)} bash -ceu '! test -r ${target} && ! test -x ${target}'`)),
    ...realmPaths.map((target) => `${drop(DAIMON_GATEWAY_UID)} bash -ceu 'probe=${target}/.daimon-gateway-probe; umask 077; : > "$probe"; rm "$probe"'`),
    `${drop(DAIMON_GATEWAY_UID)} env -i PATH="$PATH" HOME=/nonexistent LANG=C.UTF-8 ${path.posix.join(runtimeRoot, "bin/daimon-runtime")} gateway --config ${DAIMON_GATEWAY_CONFIG} &`,
    "gateway_pid=$!",
    "startup_children+=(\"$gateway_pid\")",
    `wait_for_broker_identity "$gateway_pid" ${DAIMON_GATEWAY_UID} 0000000000000000 "auth gateway"`,
    "until (exec 3<>/dev/tcp/127.0.0.1/" + DAIMON_GATEWAY_PORT + ") 2>/dev/null; do",
    "  if ! kill -0 \"$gateway_pid\" 2>/dev/null; then echo \"auth gateway exited before readiness\" >&2; exit 1; fi",
    "  if [ $((SECONDS - broker_startup_started)) -ge \"$broker_startup_timeout_seconds\" ]; then echo \"auth gateway readiness timed out after ${broker_startup_timeout_seconds}s\" >&2; exit 1; fi",
    "  sleep \"$broker_startup_poll_seconds\"",
    "done",
    "fi"
  ];
};

/** Env assignments prefixed onto the organization runtime launch; empty without a gateway. */
export const renderDaimonGatewayRuntimeEnv = (plans: readonly RuntimeTargetPlan[]): string =>
  resolveDaimonGatewayEngines(plans).length === 0
    ? ""
    : `${DAIMON_GATEWAY_URL_ENV}="$${URL_VARIABLE}" ${DAIMON_GATEWAY_KEY_ENV}="$${KEY_VARIABLE}" `;

/** The training sidecar answers on its run's private network under this alias. */
export const DAIMON_GATEWAY_SIDECAR_ALIAS = "daimon-gateway";
export const DAIMON_GATEWAY_SIDECAR_URL = `http://${DAIMON_GATEWAY_SIDECAR_ALIAS}:${DAIMON_GATEWAY_PORT}`;
/** Env name carrying the run's 64-hex gateway key into the sidecar's root shell; unset before anything else starts. */
export const DAIMON_GATEWAY_SIDECAR_KEY_ENV = "SPAWNFILE_DAIMON_GATEWAY_KEY";

/**
 * Root script for the sidecar placement: the same binary, state provisioning
 * and uid as the in-container gateway, bound to the run's private network
 * instead of loopback, with the run's key supplied rather than generated.
 * Trials reach it at {@link DAIMON_GATEWAY_SIDECAR_URL} with that key.
 */
export const renderDaimonGatewaySidecarScript = (engines: readonly string[], runtimeRoot: string): string => {
  const descriptors = daimonGatewayedEngines(engines);
  if (descriptors.length === 0) throw new Error("the auth gateway sidecar needs at least one gatewayed engine");
  return [
    "set -euo pipefail",
    `if ! getent group ${DAIMON_GATEWAY_UID} >/dev/null; then groupadd -K GID_MIN=1 --gid ${DAIMON_GATEWAY_UID} daimon-${DAIMON_GATEWAY_UID}; fi`,
    `if ! getent passwd ${DAIMON_GATEWAY_UID} >/dev/null; then useradd -K UID_MIN=1 --no-create-home --no-log-init --uid ${DAIMON_GATEWAY_UID} --gid ${DAIMON_GATEWAY_UID} --home-dir /nonexistent --shell /usr/sbin/nologin daimon-${DAIMON_GATEWAY_UID}; fi`,
    `${KEY_VARIABLE}=\${${DAIMON_GATEWAY_SIDECAR_KEY_ENV}:?the gateway sidecar needs its run key}`,
    `unset ${DAIMON_GATEWAY_SIDECAR_KEY_ENV}`,
    ...renderDaimonGatewayStateProvisioning(descriptors, "0.0.0.0"),
    `unset ${KEY_VARIABLE}`,
    `exec ${drop(DAIMON_GATEWAY_UID)} env -i PATH="$PATH" HOME=/nonexistent LANG=C.UTF-8 ${path.posix.join(runtimeRoot, "bin/daimon-runtime")} gateway --config ${DAIMON_GATEWAY_CONFIG}`
  ].join("\n") + "\n";
};
