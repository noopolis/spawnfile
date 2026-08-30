import path from "node:path";

import {
  DAIMON_GROK_ENGINE_BROKER,
  DAIMON_GROK_TURN_USAGE_LEDGER
} from "../runtime/daimon/contractManifest.js";
import type { RuntimeTargetPlan } from "./containerArtifactsTypes.js";

export const DAIMON_ORGANIZATION_UID = 2_000;
export const DAIMON_BROKER_UID = 2_100;
export const DAIMON_FIRST_WORKER_UID = 2_200;
export const DAIMON_BROKER_EXECUTABLE = "/opt/daimon/bin/daimon-engine-broker";
export const DAIMON_BROKER_REGISTRATIONS = "/etc/daimon-engine-broker/registrations.bin";
export const DAIMON_BROKER_SOCKET = "/run/daimon-engine-broker/control.sock";
export const DAIMON_BROKER_BACKEND_SOCKET = "/run/daimon-engine-broker/backend.sock";
export const DAIMON_BROKER_LAUNCHER_SOCKET = "/run/daimon-engine-broker/launcher.sock";
export const DAIMON_BROKER_SERVICE_CONFIG = "/etc/daimon-engine-broker/service.json";
export const DAIMON_BROKER_REALM = "/var/lib/spawnfile/daimon/grok-subscription-realm";
export const DAIMON_WORKER_ROOT = "/var/lib/daimon-workers";
export const DAIMON_WORKER_ATTESTATION_ROOT = "/var/lib/daimon-worker-attestations";

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
  "const secureWorkspace = (root, uid) => { const visit = (target) => { const info = fs.lstatSync(target); if (info.isSymbolicLink()) { validateResourceLink(target, info); return; } if (info.isDirectory()) { fs.chownSync(target, 2000, uid); fs.chmodSync(target, 0o750); for (const name of fs.readdirSync(target)) visit(`${target}/${name}`); } else if (info.isFile()) { fs.chownSync(target, 2000, uid); fs.chmodSync(target, 0o640); } else throw new Error('unsafe worker workspace node'); }; visit(root); };"
];

const nodeSlug = (nodeId: string): string => nodeId.replace(/^agent:/u, "")
  .toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");

export const resolveDaimonGrokRegistrations = (plans: RuntimeTargetPlan[]) => plans
  .filter((plan) => plan.runtimeName === "daimon")
  .flatMap((plan) => Object.entries(plan.engineByNodeId ?? {})
    .filter(([, engine]) => engine === "grok")
    .map(([agentId]) => ({
      agentId,
      workspace: path.posix.join(plan.instancePaths.workspacePath, "agents", nodeSlug(agentId))
    })))
  .sort((left, right) => left.agentId.localeCompare(right.agentId))
  .map((entry, slot) => ({
    ...entry,
    home: path.posix.join(DAIMON_WORKER_ROOT, String(DAIMON_FIRST_WORKER_UID + slot)),
    slot,
    uid: DAIMON_FIRST_WORKER_UID + slot
  }));

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
  const program = [
    "const crypto = require('node:crypto'); const fs = require('node:fs');",
    `const registrations = ${JSON.stringify(registrations)};`,
    "const executable = '/usr/local/bin/grok';",
    "const digest = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest();",
    "const cString = (buffer, offset, length, value) => { const bytes = Buffer.from(value); if (bytes.length < 1 || bytes.length >= length || bytes.includes(0)) throw new Error('invalid broker registration'); bytes.copy(buffer, offset); };",
    `const records = registrations.map((entry) => { const record = Buffer.alloc(692); record.writeUInt32LE(${DAIMON_GROK_ENGINE_BROKER.nativeAbiVersion}, 0); record.writeUInt32LE(entry.slot, 4); record.writeUInt32LE(entry.uid, 8); record.writeUInt32LE(entry.uid, 12); cString(record, 16, 129, entry.agentId); cString(record, 145, 256, entry.workspace); cString(record, 401, 256, entry.home); digest.copy(record, 657); return record; });`,
    "fs.mkdirSync('/etc/daimon-engine-broker', { recursive: true, mode: 0o700 }); fs.chownSync('/etc/daimon-engine-broker', 0, 0); fs.chmodSync('/etc/daimon-engine-broker', 0o700);",
    "fs.writeFileSync('/etc/daimon-engine-broker/registrations.bin', Buffer.concat(records), { mode: 0o400, flag: 'wx' });",
    "fs.chownSync('/etc/daimon-engine-broker/registrations.bin', 0, 0); fs.chmodSync('/etc/daimon-engine-broker/registrations.bin', 0o400);",
    `fs.mkdirSync('${DAIMON_BROKER_REALM}', { recursive: true, mode: 0o700 }); fs.chownSync('${DAIMON_BROKER_REALM}', 2100, 2100); fs.chmodSync('${DAIMON_BROKER_REALM}', 0o700);`,
    `fs.mkdirSync('${DAIMON_GROK_TURN_USAGE_LEDGER.directoryPath}', { recursive: true, mode: 0o750 }); fs.chownSync('${DAIMON_GROK_TURN_USAGE_LEDGER.directoryPath}', 2100, 2100); fs.chmodSync('${DAIMON_GROK_TURN_USAGE_LEDGER.directoryPath}', 0o750);`,
    `const bootstrap = '/var/lib/spawnfile/daimon/grok-bootstrap-auth', authority = '${DAIMON_BROKER_REALM}/auth.json';`,
    "const readSecure = (file, owner, label) => { const before = fs.lstatSync(file); if (!before.isFile() || before.isSymbolicLink() || (owner !== undefined && (before.uid !== owner || before.gid !== owner)) || (before.mode & 0o777) !== 0o600 || before.nlink !== 1 || before.size < 2 || before.size > 65536) throw new Error(`unsafe broker credential ${label}`); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); try { const opened = fs.fstatSync(fd); if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`unsafe broker credential ${label}`); const bytes = Buffer.alloc(opened.size); let offset = 0; while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (count < 1) throw new Error(`unsafe broker credential ${label}`); offset += count; } return bytes; } finally { fs.closeSync(fd); } };",
    `const atomicOwned = (target, bytes) => { const temporary = \`${"${target}"}.\${process.pid}.\${crypto.randomUUID()}.tmp\`; try { const output = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); try { let written = 0; while (written < bytes.length) written += fs.writeSync(output, bytes, written, bytes.length - written, written); fs.fchownSync(output, 2100, 2100); fs.fchmodSync(output, 0o600); fs.fsyncSync(output); } finally { fs.closeSync(output); } fs.renameSync(temporary, target); const directory = fs.openSync(require('node:path').dirname(target), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); } } catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; } };`,
    "let existing; try { existing = fs.lstatSync(authority); } catch (error) { if (error.code !== 'ENOENT') throw error; } const bootstrapBytes = readSecure(bootstrap, undefined, 'bootstrap'); let bootstrapRecord; try { const root = JSON.parse(bootstrapBytes.toString('utf8')), rows = root && typeof root === 'object' && !Array.isArray(root) ? Object.entries(root).filter(([key, value]) => /^https:\\/\\/auth\\.x\\.ai::/.test(key) && value && typeof value === 'object' && !Array.isArray(value)).map(([, value]) => value) : []; if (rows.length !== 1 || typeof rows[0].key !== 'string' || !rows[0].key.trim() || typeof rows[0].refresh_token !== 'string' || !rows[0].refresh_token.trim() || typeof rows[0].expires_at !== 'string' || !Number.isFinite(Date.parse(rows[0].expires_at))) throw new Error(); bootstrapRecord = true; } catch { bootstrapBytes.fill(0); throw new Error('invalid broker credential bootstrap'); } if (!bootstrapRecord) throw new Error('invalid broker credential bootstrap'); const bootstrapDigest = crypto.createHash('sha256').update(bootstrapBytes).digest('hex');",
    `try { const journalPath = '${DAIMON_BROKER_REALM}/.daimon-broker/credential-journal.json'; let journal; try { const raw = readSecure(journalPath, 2100, 'recovery journal'); journal = JSON.parse(raw.toString('utf8')); raw.fill(0); } catch (error) { if (error.code !== 'ENOENT') throw error; } const stale = journal?.version === 'noopolis.daimon.broker-credential-journal.v1' && journal.state === 'stale'; const recover = () => { if (!stale || !Number.isSafeInteger(journal.generation) || journal.generation < 0 || !/^[a-f0-9]{64}$/.test(journal.sourceDigest) || journal.sourceDigest !== journal.promotedDigest || bootstrapDigest === journal.sourceDigest) throw new Error('unsafe broker credential recovery'); atomicOwned(authority, bootstrapBytes); const recovered = Buffer.from(\`${"${JSON.stringify({ version: 'noopolis.daimon.broker-credential-journal.v1', state: 'promoted', generation: journal.generation + 1, sourceDigest: journal.sourceDigest, promotedDigest: bootstrapDigest })}"}\\n\`); try { atomicOwned(journalPath, recovered); } finally { recovered.fill(0); } }; if (!existing) { if (stale) recover(); else atomicOwned(authority, bootstrapBytes); } else { const authorityBytes = readSecure(authority, 2100, 'authority'); try { const authorityDigest = crypto.createHash('sha256').update(authorityBytes).digest('hex'); if (stale) { if (authorityDigest !== journal.sourceDigest && authorityDigest !== bootstrapDigest) throw new Error('unsafe broker credential recovery'); if (authorityDigest === bootstrapDigest) { const recovered = Buffer.from(\`${"${JSON.stringify({ version: 'noopolis.daimon.broker-credential-journal.v1', state: 'promoted', generation: journal.generation + 1, sourceDigest: journal.sourceDigest, promotedDigest: bootstrapDigest })}"}\\n\`); try { atomicOwned(journalPath, recovered); } finally { recovered.fill(0); } } else recover(); } } finally { authorityBytes.fill(0); } } } finally { bootstrapBytes.fill(0); }`,
    "const config = '[auth_provider.daimon]\\ntype = \"custom\"\\ncommand = \"/opt/daimon/bin/daimon-engine-broker\"\\nargs = [\"--auth-provider\"]\\n\\n[model.daimon-broker-grok]\\nmodel = \"grok-build\"\\nbase_url = \"http://127.0.0.1:43123/v1\"\\nauth_provider = \"daimon\"\\ncontext_window = 131072\\nsupports_backend_search = false\\n\\n[mcp_servers.daimon]\\nurl = \"http://127.0.0.1:43124/mcp\"\\nheaders = { Authorization = \"Bearer ${DAIMON_MCP_CAPABILITY}\" }\\n';",
    `for (const root of ['${DAIMON_WORKER_ROOT}','${DAIMON_WORKER_ATTESTATION_ROOT}']) { fs.mkdirSync(root, { recursive: true, mode: 0o711 }); fs.chownSync(root, 0, 0); fs.chmodSync(root, 0o711); }`,
    ...renderDaimonWorkspaceResourceSecurity(workspaceResources),
    `const deniedFor = (entry) => registrations.filter((peer) => peer.uid !== entry.uid).flatMap((peer) => [peer.home, peer.workspace]).concat(['${DAIMON_BROKER_REALM}', '/var/lib/spawnfile/daimon/grok-bootstrap-auth', '/run/daimon-engine-broker', '/var/lib/spawnfile/instances/daimon/daimon-organization/state', '${DAIMON_GROK_TURN_USAGE_LEDGER.directoryPath}']);`,
    "const profileFor = (entry) => `[profiles.daimon-strict]\\nextends = \"strict\"\\nrestrict_network = true\\ndeny = [${deniedFor(entry).map(JSON.stringify).join(', ')}]\\n`;",
    "const ensureDirectory = (target, uid, gid, mode) => { fs.mkdirSync(target, { recursive: true, mode }); const info = fs.lstatSync(target); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe worker runtime directory'); fs.chownSync(target, uid, gid); fs.chmodSync(target, mode); };",
    "const ensureExactFile = (target, content, uid, gid, mode) => { let info; try { info = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; fs.writeFileSync(target, content, { mode, flag: 'wx' }); info = fs.lstatSync(target); } if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('unsafe worker runtime file'); const existing = fs.readFileSync(target, 'utf8'); if (existing !== content) throw new Error('worker runtime file identity mismatch'); fs.chownSync(target, uid, gid); fs.chmodSync(target, mode); };",
    "const ensureEventsFile = (target, uid) => { let info; try { info = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; fs.writeFileSync(target, '', { mode: 0o640, flag: 'wx' }); info = fs.lstatSync(target); } if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.uid !== uid && info.uid !== 0) || (info.gid !== 2100 && info.gid !== 0) || ![0o600,0o640].includes(info.mode & 0o777)) throw new Error('unsafe worker attestation events'); fs.chownSync(target, uid, 2100); fs.chmodSync(target, 0o640); };",
    "const ensureExactLink = (target, source) => { let info; try { info = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; fs.symlinkSync(source, target); info = fs.lstatSync(target); } if (!info.isSymbolicLink() || info.nlink !== 1 || fs.readlinkSync(target) !== source) throw new Error('worker runtime link identity mismatch'); };",
    `for (const entry of registrations) { secureWorkspace(entry.workspace, entry.uid); ensureDirectory(entry.home, entry.uid, entry.uid, 0o700); const configRoot = \`${"${entry.home}"}/.grok\`; ensureDirectory(configRoot, 0, 0, 0o555); const configPath = \`${"${configRoot}"}/config.toml\`; ensureExactFile(configPath, config, 0, 0, 0o444); const attestationRoot = \`${DAIMON_WORKER_ATTESTATION_ROOT}/\${entry.uid}\`; ensureDirectory(attestationRoot, 0, 0, 0o755); const profilePath = \`${"${attestationRoot}"}/sandbox.toml\`, eventsPath = \`${"${attestationRoot}"}/sandbox-events.jsonl\`; ensureExactFile(profilePath, profileFor(entry), 0, 0, 0o444); ensureEventsFile(eventsPath, entry.uid); ensureExactLink(\`${"${configRoot}"}/sandbox.toml\`, profilePath); ensureExactLink(\`${"${configRoot}"}/sandbox-events.jsonl\`, eventsPath); }`,
    `const service = { version: 'noopolis.daimon.engine-broker-service.v1', credentialHome: '/var/lib/spawnfile/daimon/grok-subscription-realm', turnStore: '/var/lib/spawnfile/daimon/grok-subscription-realm/turns', registrations: registrations.map((entry) => { const attestationRoot = \`${DAIMON_WORKER_ATTESTATION_ROOT}/\${entry.uid}\`, profilePath = \`${"${attestationRoot}"}/sandbox.toml\`, eventsPath = \`${"${attestationRoot}"}/sandbox-events.jsonl\`; return { agentId: entry.agentId, slot: entry.slot, workerUid: entry.uid, workspace: entry.workspace, profilePath, eventsPath, profileSha256: crypto.createHash('sha256').update(profileFor(entry)).digest('hex') }; }) };`,
    "fs.writeFileSync('/etc/daimon-engine-broker/service.json', `${JSON.stringify(service)}\n`, { mode: 0o440, flag: 'wx' }); fs.chownSync('/etc/daimon-engine-broker/service.json', 0, 2100); fs.chmodSync('/etc/daimon-engine-broker/service.json', 0o440);",
    "fs.chmodSync('/etc/daimon-engine-broker', 0o555);"
  ].join("\n");
  return [
    "rm -rf /etc/daimon-engine-broker /run/daimon-engine-broker",
    `install -d -o root -g ${DAIMON_BROKER_UID} -m 0731 /run/daimon-engine-broker`,
    "node <<'SPAWNFILE_DAIMON_BROKER_PROVISION'",
    program,
    "SPAWNFILE_DAIMON_BROKER_PROVISION"
  ];
};
