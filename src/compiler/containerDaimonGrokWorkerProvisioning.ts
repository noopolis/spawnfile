import { DAIMON_GROK_ENGINE_BROKER } from "../runtime/daimon/contractManifest.js";
import { DAIMON_BROKER_UID } from "../runtime/daimon/runtimeIdentity.js";
import {
  DAIMON_GROK_DENIED_STATE_ROOTS,
  DAIMON_GROK_OPTIONAL_DENY_PATHS,
  DAIMON_GROK_WORKER_READ_ONLY_FILES,
  DAIMON_WORKER_ROOT,
  renderDaimonGrokServiceConfig,
  type DaimonGrokRegistration
} from "./containerDaimonGrokWorkerRender.js";

/** Only the bytes the program writes; everything else it needs is recomputed or checked in place. */
const programRegistration = (entry: DaimonGrokRegistration) => ({
  agentId: entry.agentId,
  config: entry.config,
  configSha256: entry.configSha256,
  deferredDenyPaths: entry.deferredDenyPaths,
  denyPaths: entry.denyPaths,
  eventsPath: entry.eventsPath,
  grokHome: entry.grokHome,
  home: entry.home,
  profile: entry.profile,
  profilePath: entry.profilePath,
  profileSha256: entry.profileSha256,
  slot: entry.slot,
  uid: entry.uid,
  workspace: entry.workspace
});

/**
 * Root provisioning for every brokered Grok worker, as lines of the broker's
 * node provisioning program (which already defines `crypto`, `fs`, and
 * `secureWorkspace`).
 *
 * Layout per Daimon's `GROK_ENGINE_BROKER.worker.home` (attested by the broker
 * before every turn): `$GROK_HOME` (`<home>/.grok`) and `$GROK_HOME/sessions`
 * are `root:<worker> 1771`; `config.toml` (Daimon's renderer bytes for the
 * declared model x effort), `sandbox.toml`, and the empty `trusted_folders.toml`,
 * `managed_config.toml` and `requirements.toml` are `root:root 0444`, so the
 * worker can neither write, rename nor unlink any file that decides a turn —
 * trust included; `sessions/sandbox-events.jsonl` is `<worker>:<broker> 0640`.
 *
 * Every path handed to Daimon (workspace, home, profile, events, and each deny
 * entry) must be canonical: it exists, is not a symlink, and resolves to itself.
 * Daimon never resolves these paths, so a symlinked entry would silently mask
 * the wrong inode. Root chmods only paths it owns at that moment (no
 * `CAP_FOWNER`): reclaim, mode, then hand over.
 */
export const renderDaimonGrokWorkerProvisioning = (registrations: readonly DaimonGrokRegistration[]): string[] => [
  `const grokWorkers = ${JSON.stringify(registrations.map(programRegistration))};`,
  `const optionalDenyPaths = new Set(${JSON.stringify([...DAIMON_GROK_OPTIONAL_DENY_PATHS, ...DAIMON_GROK_DENIED_STATE_ROOTS])});`,
  `const pinnedConfigSha256 = new Set(${JSON.stringify(Object.values(DAIMON_GROK_ENGINE_BROKER.worker.configSha256).flatMap((efforts) => Object.values(efforts)))});`,
  "const sha256Hex = (value) => crypto.createHash('sha256').update(value).digest('hex');",
  "for (const entry of grokWorkers) { if (sha256Hex(entry.config) !== entry.configSha256 || !pinnedConfigSha256.has(entry.configSha256) || sha256Hex(entry.profile) !== entry.profileSha256 || entry.denyPaths.length === 0) throw new Error(`Grok worker contract bytes for ${entry.agentId} do not match their pins`); }",
  "const assertCanonical = (target, label) => { const info = fs.lstatSync(target); if (info.isSymbolicLink() || fs.realpathSync(target) !== target) throw new Error(`Grok worker ${label} is not a canonical non-symlink path: ${target}`); return info; };",
  "const ensureDirectory = (target, uid, gid, mode) => { fs.mkdirSync(target, { recursive: true, mode: 0o700 }); const info = fs.lstatSync(target); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe worker runtime directory'); fs.chownSync(target, 0, 0); fs.chmodSync(target, mode); fs.chownSync(target, uid, gid); };",
  "const ensureExactFile = (target, content, mode) => { let info; try { info = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; fs.writeFileSync(target, content, { mode, flag: 'wx' }); info = fs.lstatSync(target); } if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('unsafe worker runtime file'); if (fs.readFileSync(target, 'utf8') !== content) throw new Error(`worker runtime file identity mismatch: ${target}`); fs.chownSync(target, 0, 0); fs.chmodSync(target, mode); };",
  `const ensureEventsFile = (target, uid) => { let info; try { info = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; fs.writeFileSync(target, '', { mode: 0o640, flag: 'wx' }); info = fs.lstatSync(target); } if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.uid !== uid && info.uid !== 0) || ![0, uid, ${DAIMON_BROKER_UID}].includes(info.gid) || ![0o600, 0o640, 0o644].includes(info.mode & 0o777)) throw new Error('unsafe worker attestation events'); fs.chownSync(target, 0, 0); fs.chmodSync(target, 0o640); fs.chownSync(target, uid, ${DAIMON_BROKER_UID}); };`,
  `fs.mkdirSync('${DAIMON_WORKER_ROOT}', { recursive: true, mode: 0o711 }); fs.chownSync('${DAIMON_WORKER_ROOT}', 0, 0); fs.chmodSync('${DAIMON_WORKER_ROOT}', 0o711); assertCanonical('${DAIMON_WORKER_ROOT}', 'worker root');`,
  // Pass 1: every workspace and home exists, root-held, before any deny list is checked.
  `for (const entry of grokWorkers) { for (let ancestor = require('node:path').dirname(entry.workspace); ancestor.startsWith('/var/lib/spawnfile/') && ancestor.length > '/var/lib/spawnfile'.length; ancestor = require('node:path').dirname(ancestor)) fs.chmodSync(ancestor, fs.statSync(ancestor).mode & 0o7777 | 0o011); secureWorkspace(entry.workspace, entry.uid); assertCanonical(entry.workspace, 'workspace'); ensureDirectory(entry.home, 0, 0, 0o700); ensureDirectory(entry.grokHome, 0, 0, 0o700); ensureDirectory(\`\${entry.grokHome}/sessions\`, 0, 0, 0o700); for (const target of [entry.home, entry.grokHome]) assertCanonical(target, 'home'); }`,
  "for (const denied of optionalDenyPaths) { try { fs.lstatSync(denied); } catch (error) { if (error.code !== 'ENOENT') throw error; fs.mkdirSync(denied, { mode: 0o700 }); fs.chownSync(denied, 0, 0); fs.chmodSync(denied, 0o700); } }",
  "for (const entry of grokWorkers) for (const denied of entry.denyPaths) { try { assertCanonical(denied, 'deny path'); } catch (error) { if (error.code === 'ENOENT' && entry.deferredDenyPaths.includes(denied)) continue; if (error.code === 'ENOENT') throw new Error(`Grok worker deny path is missing: ${denied}`); throw error; } }",
  // Pass 2: exact root-owned read-only files, the events file, then the final sticky modes.
  `for (const entry of grokWorkers) { ensureExactFile(\`\${entry.grokHome}/config.toml\`, entry.config, 0o444); ensureExactFile(entry.profilePath, entry.profile, 0o444); for (const name of ${JSON.stringify(DAIMON_GROK_WORKER_READ_ONLY_FILES.filter((name) => name !== "config.toml" && name !== "sandbox.toml"))}) ensureExactFile(\`\${entry.grokHome}/\${name}\`, '', 0o444); ensureEventsFile(entry.eventsPath, entry.uid); ensureDirectory(\`\${entry.grokHome}/sessions\`, 0, entry.uid, 0o1771); ensureDirectory(entry.grokHome, 0, entry.uid, 0o1771); ensureDirectory(entry.home, entry.uid, ${DAIMON_BROKER_UID}, 0o710); for (const target of [entry.profilePath, entry.eventsPath, \`\${entry.grokHome}/config.toml\`]) assertCanonical(target, 'home file'); }`,
  `const service = ${JSON.stringify(renderDaimonGrokServiceConfig(registrations))};`,
  "for (const registration of service.registrations) { const entry = grokWorkers.find((worker) => worker.agentId === registration.agentId); if (!entry || registration.profileSha256 !== sha256Hex(fs.readFileSync(entry.profilePath, 'utf8'))) throw new Error('Grok broker service registration does not match its provisioned profile'); }",
  `fs.writeFileSync('${DAIMON_GROK_ENGINE_BROKER.serviceConfigPath}', \`\${JSON.stringify(service)}\\n\`, { mode: 0o440, flag: 'wx' }); fs.chownSync('${DAIMON_GROK_ENGINE_BROKER.serviceConfigPath}', 0, ${DAIMON_BROKER_UID}); fs.chmodSync('${DAIMON_GROK_ENGINE_BROKER.serviceConfigPath}', 0o440);`
];

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

/**
 * Grok 1.0.34 runs every sandbox profile inside bubblewrap, which needs
 * unprivileged user namespaces. Ubuntu 24.04+ hosts (and Colima's default VM)
 * ship `kernel.apparmor_restrict_unprivileged_userns=1`, under which bubblewrap
 * cannot create them even with the pinned seccomp profile — every worker turn
 * would then fail attestation long after startup. The container sees the host
 * kernel's sysctls read-only, so this refuses to start with the fix named.
 */
export const renderDaimonGrokHostPreflight = (procSys = "/proc/sys"): string[] => [
  `if [ -r ${shellQuote(`${procSys}/kernel/apparmor_restrict_unprivileged_userns`)} ] && [ "$(cat ${shellQuote(`${procSys}/kernel/apparmor_restrict_unprivileged_userns`)})" != 0 ]; then echo "Daimon Grok workers need unprivileged user namespaces for bubblewrap: set kernel.apparmor_restrict_unprivileged_userns=0 on the Docker host (sysctl -w kernel.apparmor_restrict_unprivileged_userns=0; persist it in /etc/sysctl.d)" >&2; exit 1; fi`,
  `if [ -r ${shellQuote(`${procSys}/user/max_user_namespaces`)} ] && [ "$(cat ${shellQuote(`${procSys}/user/max_user_namespaces`)})" = 0 ]; then echo "Daimon Grok workers need unprivileged user namespaces for bubblewrap: user.max_user_namespaces is 0 on the Docker host" >&2; exit 1; fi`
];
