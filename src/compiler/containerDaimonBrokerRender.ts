import {
  DAIMON_GROK_ENGINE_BROKER,
  DAIMON_GROK_TURN_USAGE_LEDGER
} from "../runtime/daimon/contractManifest.js";
import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";
import { resolveDaimonGrokRegistrations, type DaimonGrokRegistration, type DaimonGrokServiceConfigOptions } from "./containerDaimonGrokWorkerRender.js";
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
  const { directoryPath } = DAIMON_GROK_TURN_USAGE_LEDGER;
  return [
    `chown 0:0 ${directoryPath} && chmod 0770 ${directoryPath} && chown ${DAIMON_BROKER_UID}:${DAIMON_ORGANIZATION_UID} ${directoryPath}`,
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
 * registrations and workspace resources.
 *
 * Production reaches it through {@link renderDaimonBrokerProvisioning}; the
 * broker-capable training container reaches it directly for its single fixed
 * slot, with `serviceOptions` pointing the turn store at per-slot tmpfs and
 * declaring the evaluator inference ledger. Both callers get byte-identical
 * credential, registration, worker-home, temp and spill provisioning — the
 * whole point of sharing it rather than writing a second root program.
 *
 * It is re-runnable: the shell wrapper removes `/etc/daimon-engine-broker` and
 * `/run/daimon-engine-broker` first, so a slot recycle replays exactly the
 * audited start-up path, credential-journal recovery included.
 */
export const renderDaimonBrokerProvisioningProgram = (
  registrations: readonly DaimonGrokRegistration[],
  workspaceResources: WorkspaceSecurityResource[],
  serviceOptions: DaimonGrokServiceConfigOptions = {}
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
    // The usage ledger directory itself is provisioned unconditionally by
    // `renderDaimonUsageLedgerProvisioning` (every Daimon organization writes
    // here, not just Grok ones) before this script's caller reaches the
    // broker startup this function guards; this script only ever reads the
    // path below, for the sandbox denylist.
    `const bootstrap = '/var/lib/spawnfile/daimon/grok-bootstrap-auth', authority = '${DAIMON_BROKER_REALM}/auth.json';`,
    "const readSecure = (file, owner, label) => { const before = fs.lstatSync(file); if (!before.isFile() || before.isSymbolicLink() || (owner !== undefined && (before.uid !== owner || before.gid !== owner)) || (before.mode & 0o777) !== 0o600 || before.nlink !== 1 || before.size < 2 || before.size > 65536) throw new Error(`unsafe broker credential ${label}`); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); try { const opened = fs.fstatSync(fd); if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`unsafe broker credential ${label}`); const bytes = Buffer.alloc(opened.size); let offset = 0; while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (count < 1) throw new Error(`unsafe broker credential ${label}`); offset += count; } return bytes; } finally { fs.closeSync(fd); } };",
    `const atomicOwned = (target, bytes) => { const temporary = \`${"${target}"}.\${process.pid}.\${crypto.randomUUID()}.tmp\`; try { const output = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); try { let written = 0; while (written < bytes.length) written += fs.writeSync(output, bytes, written, bytes.length - written, written); fs.fchmodSync(output, 0o600); fs.fchownSync(output, 2100, 2100); fs.fsyncSync(output); } finally { fs.closeSync(output); } fs.renameSync(temporary, target); const directory = fs.openSync(require('node:path').dirname(target), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); } } catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; } };`,
    "let existing; try { existing = fs.lstatSync(authority); } catch (error) { if (error.code !== 'ENOENT') throw error; } const bootstrapBytes = readSecure(bootstrap, undefined, 'bootstrap'); let bootstrapRecord; try { const root = JSON.parse(bootstrapBytes.toString('utf8')), rows = root && typeof root === 'object' && !Array.isArray(root) ? Object.entries(root).filter(([key, value]) => /^https:\\/\\/auth\\.x\\.ai::/.test(key) && value && typeof value === 'object' && !Array.isArray(value)).map(([, value]) => value) : []; if (rows.length !== 1 || typeof rows[0].key !== 'string' || !rows[0].key.trim() || typeof rows[0].refresh_token !== 'string' || !rows[0].refresh_token.trim() || typeof rows[0].expires_at !== 'string' || !Number.isFinite(Date.parse(rows[0].expires_at))) throw new Error(); bootstrapRecord = true; } catch { bootstrapBytes.fill(0); throw new Error('invalid broker credential bootstrap'); } if (!bootstrapRecord) throw new Error('invalid broker credential bootstrap'); const bootstrapDigest = crypto.createHash('sha256').update(bootstrapBytes).digest('hex');",
    `const journalRoot = '${DAIMON_BROKER_REALM}/.daimon-broker'; let journalRootExists = false; try { const info = fs.lstatSync(journalRoot); if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 2100 || info.gid !== 2100 || (info.mode & 0o777) !== 0o700) throw new Error('unsafe broker credential journal directory'); fs.chownSync(journalRoot, 0, 0); fs.chmodSync(journalRoot, 0o700); journalRootExists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }`,
    `try { const journalPath = '${DAIMON_BROKER_REALM}/.daimon-broker/credential-journal.json'; let journal; try { const raw = readSecure(journalPath, 2100, 'recovery journal'); journal = JSON.parse(raw.toString('utf8')); raw.fill(0); } catch (error) { if (error.code !== 'ENOENT') throw error; } const stale = journal?.version === 'noopolis.daimon.broker-credential-journal.v1' && journal.state === 'stale'; const recover = () => { if (!stale || !Number.isSafeInteger(journal.generation) || journal.generation < 0 || !/^[a-f0-9]{64}$/.test(journal.sourceDigest) || journal.sourceDigest !== journal.promotedDigest || bootstrapDigest === journal.sourceDigest) throw new Error('unsafe broker credential recovery'); atomicOwned(authority, bootstrapBytes); const recovered = Buffer.from(\`${"${JSON.stringify({ version: 'noopolis.daimon.broker-credential-journal.v1', state: 'promoted', generation: journal.generation + 1, sourceDigest: journal.sourceDigest, promotedDigest: bootstrapDigest })}"}\\n\`); try { atomicOwned(journalPath, recovered); } finally { recovered.fill(0); } }; if (!existing) { if (stale) recover(); else atomicOwned(authority, bootstrapBytes); } else { const authorityBytes = readSecure(authority, 2100, 'authority'); try { const authorityDigest = crypto.createHash('sha256').update(authorityBytes).digest('hex'); if (stale) { if (authorityDigest !== journal.sourceDigest && authorityDigest !== bootstrapDigest) throw new Error('unsafe broker credential recovery'); if (authorityDigest === bootstrapDigest) { const recovered = Buffer.from(\`${"${JSON.stringify({ version: 'noopolis.daimon.broker-credential-journal.v1', state: 'promoted', generation: journal.generation + 1, sourceDigest: journal.sourceDigest, promotedDigest: bootstrapDigest })}"}\\n\`); try { atomicOwned(journalPath, recovered); } finally { recovered.fill(0); } } else recover(); } } finally { authorityBytes.fill(0); } } } finally { bootstrapBytes.fill(0); }`,
    "if (journalRootExists) { fs.chownSync(journalRoot, 0, 0); fs.chmodSync(journalRoot, 0o700); fs.chownSync(journalRoot, 2100, 2100); }",
    ...renderDaimonWorkspaceResourceSecurity(workspaceResources),
    ...renderDaimonGrokWorkerProvisioning(registrations, serviceOptions),
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
