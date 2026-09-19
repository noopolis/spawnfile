import { DAIMON_GROK_ENGINE_BROKER } from "../runtime/daimon/contractManifest.js";
import { DAIMON_BROKER_UID, DAIMON_ORGANIZATION_UID } from "../runtime/daimon/runtimeIdentity.js";
import {
  DAIMON_GROK_DENIED_STATE_ROOTS,
  DAIMON_GROK_OPTIONAL_DENY_PATHS,
  DAIMON_GROK_WORKER_READ_ONLY_FILES,
  DAIMON_WORKER_ROOT,
  renderDaimonGrokServiceConfig,
  type DaimonGrokRegistration,
  type DaimonGrokServiceConfigOptions
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
  model: entry.model,
  profile: entry.profile,
  profilePath: entry.profilePath,
  privateTmp: entry.privateTmp,
  profileSha256: entry.profileSha256,
  reasoningEffort: entry.reasoningEffort,
  runtimeHome: entry.runtimeHome,
  runtimeHomeMounts: entry.runtimeHomeMounts,
  spillDirectory: entry.spillDirectory,
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
export const renderDaimonGrokWorkerProvisioning = (
  registrations: readonly DaimonGrokRegistration[],
  serviceOptions: DaimonGrokServiceConfigOptions = {},
  /**
   * Deny targets this program creates root-owned `0700` when they are absent,
   * so every mask always has an inode. The default is the production
   * container's set; the training container passes its own, because its roots
   * are tmpfs mounts and `/run/secrets` and the shared state roots do not
   * exist there at all.
   */
  optionalDenyPaths: readonly string[] = [...DAIMON_GROK_OPTIONAL_DENY_PATHS, ...DAIMON_GROK_DENIED_STATE_ROOTS]
): string[] => [
  `const grokWorkers = ${JSON.stringify(registrations.map(programRegistration))};`,
  `const optionalDenyPaths = new Set(${JSON.stringify([...optionalDenyPaths])});`,
  `const pinnedConfigSha256 = ${JSON.stringify(DAIMON_GROK_ENGINE_BROKER.worker.configSha256)};`,
  "const sha256Hex = (value) => crypto.createHash('sha256').update(value).digest('hex');",
  "for (const entry of grokWorkers) { if (sha256Hex(entry.config) !== entry.configSha256 || !Object.hasOwn(pinnedConfigSha256, entry.model) || !Object.hasOwn(pinnedConfigSha256[entry.model], entry.reasoningEffort) || pinnedConfigSha256[entry.model][entry.reasoningEffort] !== entry.configSha256 || sha256Hex(entry.profile) !== entry.profileSha256 || entry.denyPaths.length === 0) throw new Error(`Grok worker contract bytes for ${entry.agentId} do not match their pins`); }",
  // Root holds no CAP_FOWNER: every mode change reclaims the inode, sets the mode, then restores or hands over ownership.
  "const withMode = (target, mode, uid, gid) => { const info = fs.lstatSync(target); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`unsafe Grok worker directory: ${target}`); fs.chownSync(target, 0, 0); fs.chmodSync(target, mode); fs.chownSync(target, uid, gid); };",
  // Root holds no CAP_DAC_OVERRIDE either: before it may create inside a directory the ownership pass
  // already handed to another uid, it takes the inode back. The caller sets the final owner and mode.
  "const reclaimForRoot = (target) => { const info = fs.lstatSync(target); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`unsafe Grok worker directory: ${target}`); fs.chownSync(target, 0, 0); fs.chmodSync(target, 0o700); };",
  "const traversable = (target) => { for (let ancestor = require('node:path').dirname(target); ancestor.startsWith('/var/lib/spawnfile/') && ancestor.length > '/var/lib/spawnfile'.length; ancestor = require('node:path').dirname(ancestor)) { const info = fs.lstatSync(ancestor); if ((info.mode & 0o011) !== 0o011) withMode(ancestor, (info.mode & 0o7777) | 0o011, info.uid, info.gid); } };",
  "const assertCanonical = (target, label) => { const info = fs.lstatSync(target); if (info.isSymbolicLink() || fs.realpathSync(target) !== target) throw new Error(`Grok worker ${label} is not a canonical non-symlink path: ${target}`); return info; };",
  "const ensureDirectory = (target, uid, gid, mode) => { fs.mkdirSync(target, { recursive: true, mode: 0o700 }); const info = fs.lstatSync(target); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe worker runtime directory'); fs.chownSync(target, 0, 0); fs.chmodSync(target, mode); fs.chownSync(target, uid, gid); };",
  "const ensureExactFile = (target, content, mode) => { let info; try { info = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; fs.writeFileSync(target, content, { mode, flag: 'wx' }); info = fs.lstatSync(target); } if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('unsafe worker runtime file'); if (fs.readFileSync(target, 'utf8') !== content) throw new Error(`worker runtime file identity mismatch: ${target}`); fs.chownSync(target, 0, 0); fs.chmodSync(target, mode); };",
  `const ensureEventsFile = (target, uid) => { let info; try { info = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; fs.writeFileSync(target, '', { mode: 0o640, flag: 'wx' }); info = fs.lstatSync(target); } if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.uid !== uid && info.uid !== 0) || ![0, uid, ${DAIMON_BROKER_UID}].includes(info.gid) || ![0o600, 0o640, 0o644].includes(info.mode & 0o777)) throw new Error('unsafe worker attestation events'); fs.chownSync(target, 0, 0); fs.chmodSync(target, 0o640); fs.chownSync(target, uid, ${DAIMON_BROKER_UID}); };`,
  `fs.mkdirSync('${DAIMON_WORKER_ROOT}', { recursive: true, mode: 0o711 }); fs.chownSync('${DAIMON_WORKER_ROOT}', 0, 0); fs.chmodSync('${DAIMON_WORKER_ROOT}', 0o711); assertCanonical('${DAIMON_WORKER_ROOT}', 'worker root');`,
  // Pass 1: every workspace and home exists, root-held, before any deny list is checked.
  `for (const entry of grokWorkers) { traversable(entry.workspace); secureWorkspace(entry.workspace, entry.uid); assertCanonical(entry.workspace, 'workspace'); ensureDirectory(entry.home, 0, 0, 0o700); ensureDirectory(entry.grokHome, 0, 0, 0o700); ensureDirectory(\`\${entry.grokHome}/sessions\`, 0, 0, 0o700); for (const target of [entry.home, entry.grokHome]) assertCanonical(target, 'home'); }`,
  "for (const denied of optionalDenyPaths) { try { fs.lstatSync(denied); } catch (error) { if (error.code !== 'ENOENT') throw error; fs.mkdirSync(denied, { mode: 0o700 }); fs.chownSync(denied, 0, 0); fs.chmodSync(denied, 0o700); } }",
  "for (const entry of grokWorkers) for (const denied of entry.denyPaths) { try { assertCanonical(denied, 'deny path'); } catch (error) { if (error.code === 'ENOENT' && entry.deferredDenyPaths.includes(denied)) continue; if (error.code === 'ENOENT') throw new Error(`Grok worker deny path is missing: ${denied}`); throw error; } }",
  // Pass 2: exact root-owned read-only files, the events file, then the final sticky modes.
  `for (const entry of grokWorkers) { ensureExactFile(\`\${entry.grokHome}/config.toml\`, entry.config, 0o444); ensureExactFile(entry.profilePath, entry.profile, 0o444); for (const name of ${JSON.stringify(DAIMON_GROK_WORKER_READ_ONLY_FILES.filter((name) => name !== "config.toml" && name !== "sandbox.toml"))}) ensureExactFile(\`\${entry.grokHome}/\${name}\`, '', 0o444); ensureEventsFile(entry.eventsPath, entry.uid); ensureDirectory(\`\${entry.grokHome}/sessions\`, 0, entry.uid, 0o1771); ensureDirectory(entry.grokHome, 0, entry.uid, 0o1771); ensureDirectory(entry.privateTmp, entry.uid, entry.uid, 0o700); ensureDirectory(entry.home, entry.uid, ${DAIMON_BROKER_UID}, 0o710); for (const target of [entry.profilePath, entry.eventsPath, \`\${entry.grokHome}/config.toml\`]) assertCanonical(target, 'home file'); }`,
  // Worker-private temp: the launcher compiles TMPDIR=<home>/tmp, the only temp the worker may write. It is
  // created in the pass above, while the home is still root-owned: root here holds no CAP_DAC_OVERRIDE, so
  // once the home is `<worker>:<broker> 0710` root can no longer create anything inside it.
  "for (const entry of grokWorkers) { ensureDirectory(entry.privateTmp, entry.uid, entry.uid, 0o700); assertCanonical(entry.privateTmp, 'private temp'); }",
  // Spills: <runtimeHome>/tool-output 2000:<worker> 2750 (setgid) under a runtime home the worker's group can
  // traverse. Root reclaims the runtime home before creating the spill directory: the compiler lists every
  // organization runtime home as a private directory, so the container's ownership pass has already handed
  // it to the organization uid by the time this runs, and root here holds no CAP_DAC_OVERRIDE — a bare
  // `mkdir` inside a home root no longer owns fails EACCES and the container exits 1 at start. The trailing
  // `withMode` still narrows the home to its final `2000:<worker> 0710`, so the end state is unchanged.
  `for (const entry of grokWorkers) { traversable(entry.runtimeHome); fs.mkdirSync(entry.runtimeHome, { recursive: true, mode: 0o700 }); assertCanonical(entry.runtimeHome, 'runtime home'); reclaimForRoot(entry.runtimeHome); try { fs.mkdirSync(entry.spillDirectory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } assertCanonical(entry.spillDirectory, 'spill directory'); withMode(entry.spillDirectory, 0o2750, ${DAIMON_ORGANIZATION_UID}, entry.uid); for (const mounted of entry.runtimeHomeMounts) { assertCanonical(mounted, 'runtime home mount'); withMode(mounted, 0o700, ${DAIMON_ORGANIZATION_UID}, ${DAIMON_ORGANIZATION_UID}); } withMode(entry.runtimeHome, 0o710, ${DAIMON_ORGANIZATION_UID}, entry.uid); }`,
  // Shared temp: Grok refuses a profile denying /tmp or /var/tmp, so modes close them: root:<org group> 1774 lets workers list names only.
  `for (const shared of ${JSON.stringify(DAIMON_GROK_ENGINE_BROKER.worker.home.sharedTmp.paths)}) { fs.mkdirSync(shared, { recursive: true, mode: 0o1777 }); assertCanonical(shared, 'shared temp'); withMode(shared, 0o${DAIMON_GROK_ENGINE_BROKER.worker.home.sharedTmp.mode.toString(8)}, 0, ${DAIMON_ORGANIZATION_UID}); }`,
  // Deny-path placement, asserted once every mode above is final. Grok 1.0.34 materializes each deny
  // target inside bubblewrap AS THE WORKER UID, so the worker must be able to search every ancestor and
  // the target must already exist; one unplaceable entry makes Grok refuse the whole profile and every
  // turn of that worker fails with a bare `bwrap: Can't create file at ...: Permission denied`. Root here
  // holds CAP_DAC_READ_SEARCH, so it can read every mode the worker cannot, and decides for it.
  "const searches = (info, uid, gid) => info.uid === uid ? (info.mode & 0o100) !== 0 : info.gid === gid ? (info.mode & 0o010) !== 0 : (info.mode & 0o001) !== 0;",
  "const assertPlaceable = (denied, uid, gid) => { const parts = denied.split('/').slice(1); let at = ''; for (const part of parts.slice(0, -1)) { at += `/${part}`; let info; try { info = fs.lstatSync(at); } catch (error) { throw new Error(`Grok worker deny path ${denied} is not placeable: ${at} could not be read (${error.code})`); } if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Grok worker deny path ${denied} is not placeable: ${at} is not a directory`); if (!searches(info, uid, gid)) throw new Error(`Grok worker deny path ${denied} is not placeable: worker uid ${uid} cannot search ${at} (${(info.mode & 0o7777).toString(8)} ${info.uid}:${info.gid}); deny that directory itself instead`); } };",
  "for (const entry of grokWorkers) for (const denied of entry.denyPaths) { if (entry.deferredDenyPaths.includes(denied)) { try { fs.lstatSync(denied); } catch (error) { if (error.code === 'ENOENT') continue; throw error; } } assertPlaceable(denied, entry.uid, entry.uid); }",
  `const service = ${JSON.stringify(renderDaimonGrokServiceConfig(registrations, serviceOptions))};`,
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
