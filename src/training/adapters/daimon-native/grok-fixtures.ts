import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { grokProjectionSha256, grokWorkerConfigPins, type GrokBrokerProjection, type GrokSlotPreflight } from './receipt/grok.js';
import type { GrokNativeLaunch, NativeLaunch } from './receipt/index.js';
import type { NativeConfig } from './worker/index.js';

/** Byte-exact outputs from Daimon public projection v3 resolver. */
export const daimonProjectionGolden: GrokBrokerProjection = {
  "version": "noopolis.daimon.grok-broker-projection.v3",
  "agentId": "foreman",
  "workspacePath": "/var/lib/spawnfile/instance/workspace/agents/foreman",
  "runtimeHomePath": "/var/lib/spawnfile/instance/homes/foreman",
  "workerUid": 2200,
  "slot": 0,
  "profilePath": "/var/lib/daimon-workers/2200/.grok/sandbox.toml",
  "profileSha256": "2a1dcab471092eab77565838b17a5cf138489e3daa1349612ebcedcdb69e23c4",
  "denyPaths": [
    "/run/paideia",
    "/run/paideia/control",
    "/run/training/inputs",
    "/var/lib/spawnfile/daimon/grok-bootstrap-auth",
    "/var/lib/spawnfile/daimon/grok-subscription-realm"
  ],
  "workerConfigSha256": "ab58499ac32678097c146479896f2b8a8e2b0e39aea22dc0a60b6227e370538e",
  "workerConfigVariant": "unclocked",
  "systemPromptSha256": "2c31c0085a54a4efbf9c0cf0b8124c56e47f38691b7f0c7fa233a74abaa8ddf8",
  "grokCliVersion": "1.0.34",
  "grokExecutableSha256": "39ab87666877d64ef3a40aa60fbe0c3b6a6acd7001b78fe60e2c76bb6cfc4a94",
  "nativeAbiVersion": 2,
  "model": "grok-4.6",
  "reasoningEffort": "low",
  "limits": {
    "maxRequests": 24,
    "maxTokens": 400000,
    "timeoutMs": 480000
  },
  "usageLedgerPath": "/run/daimon-slots/0/usage/usage.jsonl",
  "seccompProfileSha256": "7777777777777777777777777777777777777777777777777777777777777777",
  "attestation": {
    "platform": "linux/landlock",
    "enforced": true,
    "restrictNetwork": true,
    "profileName": "daimon-strict",
    "sandboxRuntime": "bubblewrap",
    "eventsPath": "/var/lib/daimon-workers/2200/.grok/sessions/sandbox-events.jsonl"
  }
};
export const daimonProjectionGoldenSha256 = '542d5feed20765ce8eff4122a109a499cf85249829a40368b32e5a805a7156f0';
export const daimonClockedProjectionGolden: GrokBrokerProjection = {
  "version": "noopolis.daimon.grok-broker-projection.v3",
  "agentId": "foreman",
  "workspacePath": "/var/lib/spawnfile/instance/workspace/agents/foreman",
  "runtimeHomePath": "/var/lib/spawnfile/instance/homes/foreman",
  "workerUid": 2200,
  "slot": 0,
  "profilePath": "/var/lib/daimon-workers/2200/.grok/sandbox.toml",
  "profileSha256": "2a1dcab471092eab77565838b17a5cf138489e3daa1349612ebcedcdb69e23c4",
  "denyPaths": [
    "/run/paideia",
    "/run/paideia/control",
    "/run/training/inputs",
    "/var/lib/spawnfile/daimon/grok-bootstrap-auth",
    "/var/lib/spawnfile/daimon/grok-subscription-realm"
  ],
  "workerConfigSha256": "751f1dcd04983e5e5883df5a8fefa04f201e187e5ef1f344d3bf83f950830432",
  "workerConfigVariant": "clocked",
  "taskClock": {
    "preloadPath": "/usr/local/lib/daimon/libfaketime.so.1",
    "timestampFilePath": "/run/daimon-engine-broker/task-clock/slot-0/faketime",
    "directoryPath": "/run/daimon-engine-broker/task-clock/slot-0",
    "rootDirectoryPath": "/run/daimon-engine-broker/task-clock",
    "directoryMode": 493,
    "fileMode": 420,
    "ownerUid": 2100,
    "version": "noopolis.daimon.grok-broker-task-clock.v2",
    "slotDirectoryPattern": "/run/daimon-engine-broker/task-clock/slot-{slot}",
    "slotFilePattern": "/run/daimon-engine-broker/task-clock/slot-{slot}/faketime",
    "workerView": "own-directory-visible-sibling-directories-denied"
  },
  "systemPromptSha256": "2c31c0085a54a4efbf9c0cf0b8124c56e47f38691b7f0c7fa233a74abaa8ddf8",
  "grokCliVersion": "1.0.34",
  "grokExecutableSha256": "39ab87666877d64ef3a40aa60fbe0c3b6a6acd7001b78fe60e2c76bb6cfc4a94",
  "nativeAbiVersion": 2,
  "model": "grok-4.6",
  "reasoningEffort": "low",
  "limits": {
    "maxRequests": 24,
    "maxTokens": 400000,
    "timeoutMs": 480000
  },
  "usageLedgerPath": "/run/daimon-slots/0/usage/usage.jsonl",
  "seccompProfileSha256": "7777777777777777777777777777777777777777777777777777777777777777",
  "attestation": {
    "platform": "linux/landlock",
    "enforced": true,
    "restrictNetwork": true,
    "profileName": "daimon-strict",
    "sandboxRuntime": "bubblewrap",
    "eventsPath": "/var/lib/daimon-workers/2200/.grok/sessions/sandbox-events.jsonl"
  }
};
export const daimonClockedProjectionGoldenSha256 = 'c2494499be3778dcdaec460bf3d24b1cc933ed0622079329792c87732ed9e0ac';

export const fixtureNonce = '5f0e2a1c9b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f';
const realm = ['/var/lib/spawnfile/daimon/grok-bootstrap-auth', '/var/lib/spawnfile/daimon/grok-subscription-realm'];

/**
 * The caller-protected paths a Grok trial declares.
 *
 * Always evaluator roots the slot receipt denies to the worker uid — never the
 * subject's own workspace or runtime home, which are the two writable roots.
 */
export const grokProtectedPaths = (root: string): string[] => [join(root, 'run-paideia'), join(root, 'paideia')];

/**
 * Turns a Codex launch fixture into a Grok v2 child launch shaped like the
 * broker-capable training container.
 *
 * The container fixes `<slot>/workspace`, `<slot>/runtime-home` and
 * `<slot>/state` as siblings and keeps every Paideia control input in the
 * denied `/run/paideia` root, so the fixture root stands in for the slot root:
 * the trial runtime home is the single writable projection, the control root is
 * its sibling `state/`, and config/token/env move into the denied `paideia/`
 * evaluator root. Every evaluator root is a real directory under `root`.
 */
export async function grokLaunchFrom<T extends NativeLaunch>(launch: T, root: string, runtimeHome = join(root, 'runtime')): Promise<T & GrokNativeLaunch> {
  const slot = join(root, 'slots', '0');
  const state = join(root, 'state');
  const controls = join(root, 'paideia');
  const roots = { 'run-root': join(root, 'run-paideia'), context: controls, 'sealed-inputs': join(root, 'sealed'),
    'judge-home': join(root, 'judge-grok-home'), 'slot-ledger': join(slot, 'usage') } as const;
  for (const path of [...Object.values(roots), state]) await mkdir(path, { recursive: true, mode: 0o700 });
  const moved = { config: join(controls, 'config.json'), tokenFile: join(controls, 'token'), envFile: join(controls, 'environment') } as const;
  for (const key of ['config', 'tokenFile', 'envFile'] as const) { await copyFile(launch[key], moved[key]); await chmod(moved[key], 0o600); }
  const home = launch.projections.find(row => row.role === 'home')!;
  const next = launch as unknown as T & GrokNativeLaunch;
  Object.assign(next, { schema: 'paideia.daimon-native.launch.v2', agent: { id: launch.agent.id, engine: 'grok', model: 'grok-4.6', reasoningEffort: 'low' },
    credentials: [], limits: { maxTokens: 8000000, wakeTokenCeiling: 1000000 }, ...moved, controlRoot: state,
    projections: [{ role: 'home', source: runtimeHome, target: home.source === home.target ? runtimeHome : home.target }],
    broker: { projectionVersion: 'noopolis.daimon.grok-broker-projection.v3', workerConfigVariant: launch.taskClock ? 'clocked' : 'unclocked',
      projectionSha256: '0'.repeat(64), slot: 0, workerUid: 2200,
      workerHomePath: join(slot, 'worker-home'), architecture: 'arm64', usageLedgerPath: join(roots['slot-ledger'], 'usage.jsonl'),
      seccompProfileSha256: '7'.repeat(64), limits: { maxRequests: 24, maxTokens: 400000, timeoutMs: 480000 },
      // The provisioner's verbatim values the projection digest binds: the realm entries, the control
      // root and every evaluator root. Evaluator roots alone are the canary subset, not the deny list.
      profileSha256: daimonProjectionGolden.profileSha256,
      denyPaths: [...new Set([...realm, state, ...Object.values(roots)])].sort(),
      evaluatorPaths: Object.entries(roots).map(([role, path]) => ({ role, path })), slotPreflightReceipt: join(slot, 'slot-preflight.json'), expectedNonce: fixtureNonce, minGeneration: 3 } });
  next.broker.projectionSha256 = grokProjectionSha256(grokProjectionFor(next));
  return next;
}

/** The training container resolves the slot projection from a one-agent config with no peers and no Mneme projection. */
export function grokConfigFor(config: NativeConfig): NativeConfig {
  const agent = config.agents[0]!;
  agent.engine = { kind: 'grok', model: 'grok-4.6', reasoningEffort: 'low' };
  delete agent.memory;
  return config;
}

/** What Daimon's resolver returns for this launch when its inputs are passed through unchanged. */
export function grokProjectionFor(launch: GrokNativeLaunch, extraDeny: readonly string[] = []): GrokBrokerProjection {
  const { broker } = launch;
  const home = launch.projections.find(row => row.role === 'home')!.target;
  const golden = broker.workerConfigVariant === 'clocked' ? daimonClockedProjectionGolden : daimonProjectionGolden;
  return { ...golden, agentId: launch.agent.id, workspacePath: launch.workspace.target, runtimeHomePath: home,
    workerUid: broker.workerUid, slot: broker.slot, profilePath: `${broker.workerHomePath}/.grok/sandbox.toml`,
    denyPaths: [...new Set([...broker.denyPaths, ...extraDeny])].sort(),
    workerConfigSha256: grokWorkerConfigPins[broker.workerConfigVariant][launch.agent.model][launch.agent.reasoningEffort],
    model: launch.agent.model, reasoningEffort: launch.agent.reasoningEffort, limits: { ...broker.limits }, usageLedgerPath: broker.usageLedgerPath,
    seccompProfileSha256: broker.seccompProfileSha256, attestation: { ...daimonProjectionGolden.attestation, eventsPath: `${broker.workerHomePath}/.grok/sessions/sandbox-events.jsonl` } };
}

export function slotPreflightFor(projection: GrokBrokerProjection, paths = projection.denyPaths, generation = 3, nonce = fixtureNonce): GrokSlotPreflight {
  return { version: 'noopolis.daimon.grok-slot-preflight.v2', slot: projection.slot, worker_uid: projection.workerUid, generation, nonce,
    projection_sha256: grokProjectionSha256(projection), sandbox_profile_sha256: projection.profileSha256,
    seccomp_profile_sha256: projection.seccompProfileSha256, sandbox_runtime: 'bubblewrap', grok_executable_sha256: projection.grokExecutableSha256,
    canaries: paths.map(path => ({ path, method: 'sandboxed-read', result: 'denied' })), created_at: '2026-09-17T12:00:00.000Z' };
}

export async function writeGrokSlotReceipt(launch: GrokNativeLaunch, value: unknown = slotPreflightFor(grokProjectionFor(launch))): Promise<void> {
  await mkdir(dirname(launch.broker.slotPreflightReceipt), { recursive: true });
  await writeFile(launch.broker.slotPreflightReceipt, JSON.stringify(value));
}
