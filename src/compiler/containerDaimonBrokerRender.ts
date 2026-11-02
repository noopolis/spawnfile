import {
  DAIMON_GROK_ENGINE_BROKER,
  DAIMON_GROK_TURN_USAGE_LEDGER
} from "../runtime/daimon/contractManifest.js";
import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import { resolveDaimonGrokRegistrations, type DaimonGrokRegistration } from "./containerDaimonGrokWorkerRender.js";
import { renderDaimonGrokWorkerProvisioning } from "./containerDaimonGrokWorkerProvisioning.js";
import {
  DAIMON_BROKER_UID,
  DAIMON_FIRST_WORKER_UID,
  DAIMON_ORGANIZATION_UID
} from "../runtime/daimon/runtimeIdentity.js";

export { DAIMON_BROKER_UID, DAIMON_FIRST_WORKER_UID, DAIMON_ORGANIZATION_UID };
export const DAIMON_BROKER_EXECUTABLE = "/opt/daimon/bin/daimon-engine-broker";
export const DAIMON_BROKER_REGISTRATIONS = "/etc/daimon-engine-broker/registrations.bin";
export const DAIMON_BROKER_SOCKET = "/run/daimon-engine-broker/control.sock";
export const DAIMON_BROKER_BACKEND_SOCKET = "/run/daimon-engine-broker/backend.sock";
export const DAIMON_BROKER_LAUNCHER_SOCKET = "/run/daimon-engine-broker/launcher.sock";
export const DAIMON_BROKER_SERVICE_CONFIG = "/etc/daimon-engine-broker/service.json";
export const DAIMON_BROKER_REALM = "/var/lib/spawnfile/daimon/grok-subscription-realm";
/**
 * Private temp for the broker and its relay (uid 2100, outside the organization
 * group): shared `/tmp` and `/var/tmp` are `root:2000 1774` in a Grok
 * organization, so any non-root process outside group 2000 needs its own
 * `TMPDIR`. It lives in the broker's `/run` directory, which every worker denies.
 */
export const DAIMON_BROKER_TMPDIR = "/run/daimon-engine-broker/tmp";
export {
  DAIMON_ORGANIZATION_STATE_DIRECTORY,
  DAIMON_WORKER_ROOT,
  resolveDaimonGrokRegistrations
} from "./containerDaimonGrokWorkerRender.js";

interface WorkspaceSecurityResource {
  backingPath: string;
  kind: "bundle" | "git" | "volume";
  linkPath: string;
  mode: "mutable" | "readonly";
  resolvedIdentity: string | null;
}

export const renderDaimonWorkspaceResourceSecurity = (
  resources: WorkspaceSecurityResource[],
  owners = { linkUid: 2_000, linkGid: 2_000, readonlyUid: 2_000, readonlyGid: 2_000, privilegedUid: 0, privilegedGid: 0 },
  resourceRoot = "/var/lib/spawnfile/resources/"
): string[] => [
  `const workspaceResources = ${JSON.stringify(resources)};`,
  "const resourceByLink = new Map(workspaceResources.map((resource) => [resource.linkPath, resource])); if (resourceByLink.size !== workspaceResources.length) throw new Error('duplicate worker workspace resource link');",
  `const validateResourceLink = (target, info) => { const resource = resourceByLink.get(target); if (!resource || info.uid !== ${owners.linkUid} || info.gid !== ${owners.linkGid} || info.nlink !== 1) throw new Error('unsafe worker workspace link'); const raw = fs.readlinkSync(target), normalized = require('node:path').posix.normalize(raw); if (!raw.startsWith('/') || normalized !== raw || raw !== resource.backingPath || !raw.startsWith(${JSON.stringify(resourceRoot)})) throw new Error('unsafe worker workspace link target'); const backing = fs.lstatSync(raw); if (!backing.isDirectory() || backing.isSymbolicLink()) throw new Error('unsafe worker workspace resource'); const mode = backing.mode & 0o777; if (resource.kind === 'volume') { const lifecycleOwner = (backing.uid === ${owners.privilegedUid} && backing.gid === ${owners.privilegedGid}) || (backing.uid === ${owners.linkUid} && backing.gid === ${owners.linkGid}); if (!lifecycleOwner || mode !== 0o755 || typeof resource.resolvedIdentity !== 'string') throw new Error('unsafe worker workspace volume'); const expected = Buffer.from(\`${"${resource.resolvedIdentity}"}\\n\`); if (expected.length !== 72) throw new Error('unsafe worker workspace volume identity'); const sentinel = \`${"${raw}"}/.spawnfile-resource-identity\`; let fd; try { fd = fs.openSync(sentinel, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); const before = fs.fstatSync(fd); if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== ${owners.privilegedUid} || before.gid !== ${owners.privilegedGid} || (before.mode & 0o777) !== 0o644 || before.size !== expected.length) throw new Error('unsafe worker workspace volume identity'); const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd); if (!bytes.equals(expected) || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('unsafe worker workspace volume identity'); } finally { expected.fill(0); if (fd !== undefined) fs.closeSync(fd); } } else if (resource.mode === 'readonly') { if (backing.uid !== ${owners.readonlyUid} || backing.gid !== ${owners.readonlyGid} || mode !== 0o555) throw new Error('unsafe readonly worker workspace resource'); } else if (backing.uid !== ${owners.privilegedUid} || backing.gid !== ${owners.privilegedGid} || mode !== 0o755) throw new Error('unsafe mutable worker workspace resource'); };`,
  "const secureWorkspace = (root, uid) => { const visit = (target) => { const info = fs.lstatSync(target); if (info.isSymbolicLink()) { validateResourceLink(target, info); return; } if (info.isDirectory()) { fs.chownSync(target, 0, 0); fs.chmodSync(target, 0o750); for (const name of fs.readdirSync(target)) visit(`${target}/${name}`); fs.chownSync(target, 2000, uid); } else if (info.isFile()) { fs.chownSync(target, 0, 0); fs.chmodSync(target, 0o640); fs.chownSync(target, 2000, uid); } else throw new Error('unsafe worker workspace node'); }; visit(root); };"
];

/**
 * Fixes ownership and mode of the per-turn usage ledger directory for every
 * Daimon organization, not just ones with a Grok agent. AGY and Codex both
 * write here too (`onTurnUsage` in Daimon's `engineDispatcher.ts`), from the
 * organization-uid runtime process (`uid`/`gid` below, set in
 * `renderDaimonUidEntrypoint`) rather than the privileged broker — so this
 * must run whether or not any Grok registration exists, and the directory
 * must be group-writable (0770), not merely group-readable (0750): a mode
 * that only lets the group list the directory silently defeated every
 * AGY/Codex advisory usage write and, with it, Daimon's wake-fuse token
 * ceiling, which now refuses to start at all if this ledger is missing or
 * unreadable (`wakeFuse.ts`'s `ensureUsageLedgerReadable`).
 *
 * The directory itself is never created here: it is a persistent volume
 * mount (`daimon-grok-usage-ledger` in `config.ts`, unconditional for every
 * Daimon organization) that Docker always materializes before the entrypoint
 * runs — exactly like `DAIMON_WAKE_FUSE_DIRECTORY`, whose own fix-up
 * (`renderDaimonUidEntrypoint`) uses this same three-step order. `chown` to
 * root first, `chmod` next, `chown` to the final owner last — never
 * `install -d`'s create-then-chown-then-chmod order, and never a single
 * `chown owner:group` followed by `chmod`: root only ever chmods a path it
 * currently owns, so it never needs `CAP_FOWNER` (`runProject.ts`'s
 * capability set grants `CAP_CHOWN` but not `CAP_FOWNER`) — chmod-ing
 * *after* the final `chown` hands ownership to the broker uid fails with
 * `EPERM` the moment root no longer owns the path.
 */
export const renderDaimonUsageLedgerProvisioning = (): string[] => {
  const { directoryPath, filePath } = DAIMON_GROK_TURN_USAGE_LEDGER;
  // The ledger file itself is shared too: the broker uid appends Grok rows and
  // the organization uid appends Codex/AGY rows, and Daimon's wake fuse creates
  // it empty as the organization uid at 0640 when absent, which leaves the
  // broker unable to append and every Grok usage row silently lost. Root owns
  // it first (it holds no CAP_DAC_OVERRIDE or CAP_FOWNER), then hands it to
  // broker:organization at 0660, on every start so a reattached volume heals.
  const owner = `${DAIMON_BROKER_UID}:${DAIMON_ORGANIZATION_UID}`;
  return [
    `chown 0:0 ${directoryPath} && chmod 0770 ${directoryPath}`,
    `if [ -L ${filePath} ] || { [ -e ${filePath} ] && [ ! -f ${filePath} ]; }; then echo "usage ledger ${filePath} is not a regular file" >&2; exit 1; fi`,
    `if [ -e ${filePath} ]; then chown 0:0 ${filePath}; else (umask 077 && : > ${filePath}); fi && chmod 0660 ${filePath} && chown ${owner} ${filePath}`,
    `chown ${owner} ${directoryPath}`,
    `setpriv --clear-groups --reuid ${DAIMON_ORGANIZATION_UID} --regid ${DAIMON_ORGANIZATION_UID} --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- bash -ceu 'probe=${directoryPath}/.daimon-usage-probe; umask 007; : > "$probe"; rm "$probe"'`
  ];
};

export const renderDaimonBrokerProvisioning = (plans: RuntimeTargetPlan[]): string[] => {
  const registrations = resolveDaimonGrokRegistrations(plans);
  if (registrations.length === 0) return [];
  const workspaceResources = plans
    .filter((plan) => plan.runtimeName === "daimon")
    .flatMap((plan) => plan.resources ?? [])
    .map((resource) => ({
      backingPath: resource.backingPath,
      kind: resource.kind,
      linkPath: resource.linkPath,
      mode: resource.mode,
      resolvedIdentity: "resolvedIdentity" in resource && typeof resource.resolvedIdentity === "string"
        ? resource.resolvedIdentity
        : null
    }))
    .sort((left, right) => left.linkPath.localeCompare(right.linkPath));
  return renderDaimonBrokerProvisioningProgram(registrations, workspaceResources);
};

/**
 * The root broker provisioning program itself, over already-resolved
 * registrations and workspace resources. The auth gateway owns the Grok login,
 * so the broker home is a plain turn-state folder and no bootstrap, authority or
 * journal is staged here.
 */
export const renderDaimonBrokerProvisioningProgram = (
  registrations: readonly DaimonGrokRegistration[],
  workspaceResources: WorkspaceSecurityResource[]
): string[] => {
  const program = [
    "const crypto = require('node:crypto'); const fs = require('node:fs');",
    `const registrations = ${JSON.stringify(registrations.map(({ agentId, home, slot, uid, workspace }) => ({ agentId, home, slot, uid, workspace })))};`,
    `const executable = '${DAIMON_GROK_ENGINE_BROKER.grokExecutablePath}';`,
    "const digest = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest();",
    `if (!${JSON.stringify([DAIMON_GROK_ENGINE_BROKER.grokCliArtifacts.arm64.sha256, DAIMON_GROK_ENGINE_BROKER.grokCliArtifacts.x64.sha256])}.includes(digest.toString('hex'))) throw new Error('Grok executable is not the manifest-pinned ${DAIMON_GROK_ENGINE_BROKER.grokCliVersion} build');`,
    "const cString = (buffer, offset, length, value) => { const bytes = Buffer.from(value); if (bytes.length < 1 || bytes.length >= length || bytes.includes(0)) throw new Error('invalid broker registration'); bytes.copy(buffer, offset); };",
    `const records = registrations.map((entry) => { const record = Buffer.alloc(692); record.writeUInt32LE(${DAIMON_GROK_ENGINE_BROKER.nativeAbiVersion}, 0); record.writeUInt32LE(entry.slot, 4); record.writeUInt32LE(entry.uid, 8); record.writeUInt32LE(entry.uid, 12); cString(record, 16, 129, entry.agentId); cString(record, 145, 256, entry.workspace); cString(record, 401, 256, entry.home); digest.copy(record, 657); return record; });`,
    "fs.mkdirSync('/etc/daimon-engine-broker', { recursive: true, mode: 0o700 }); fs.chownSync('/etc/daimon-engine-broker', 0, 0); fs.chmodSync('/etc/daimon-engine-broker', 0o700);",
    "fs.writeFileSync('/etc/daimon-engine-broker/registrations.bin', Buffer.concat(records), { mode: 0o400, flag: 'wx' });",
    "fs.chownSync('/etc/daimon-engine-broker/registrations.bin', 0, 0); fs.chmodSync('/etc/daimon-engine-broker/registrations.bin', 0o400);",
    `fs.mkdirSync('${DAIMON_BROKER_REALM}', { recursive: true, mode: 0o700 }); fs.chownSync('${DAIMON_BROKER_REALM}', 0, 0); fs.chmodSync('${DAIMON_BROKER_REALM}', 0o700);`,
    ...renderDaimonWorkspaceResourceSecurity(workspaceResources),
    ...renderDaimonGrokWorkerProvisioning(registrations),
    `fs.chownSync('${DAIMON_BROKER_REALM}', 0, 0); fs.chmodSync('${DAIMON_BROKER_REALM}', 0o700); fs.chownSync('${DAIMON_BROKER_REALM}', 2100, 2100);`,
    "fs.chmodSync('/etc/daimon-engine-broker', 0o555);"
  ].join("\n");
  return [
    "if [ -d /etc/daimon-engine-broker ]; then chmod u+rwx /etc/daimon-engine-broker; fi",
    "if [ -d /run/daimon-engine-broker ]; then chmod u+rwx /run/daimon-engine-broker; fi",
    "rm -rf /etc/daimon-engine-broker /run/daimon-engine-broker",
    `install -d -o root -g ${DAIMON_BROKER_UID} -m 0731 /run/daimon-engine-broker`,
    `install -d -o ${DAIMON_BROKER_UID} -g ${DAIMON_BROKER_UID} -m 0700 ${DAIMON_BROKER_TMPDIR}`,
    "node <<'SPAWNFILE_DAIMON_BROKER_PROVISION'",
    program,
    "SPAWNFILE_DAIMON_BROKER_PROVISION"
  ];
};
