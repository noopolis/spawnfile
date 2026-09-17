import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { bindGrokBrokerProjection, grokProjectionSha256, type GrokBrokerProjection, type GrokSlotPreflight } from './receipt/grok.js';
import type { GrokNativeLaunch, NativeLaunch, VerifiedNativeLaunch } from './receipt/index.js';
import type { NativeConfig } from './worker/index.js';

/** Byte-exact output of Daimon's resolver for its `fixtures/grok-slot-preflight/projection-input.json`. */
export const daimonProjectionGolden: GrokBrokerProjection = {
  version: 'noopolis.daimon.grok-broker-projection.v1', agentId: 'foreman',
  workspacePath: '/var/lib/spawnfile/instance/workspace/agents/foreman', runtimeHomePath: '/var/lib/spawnfile/instance/homes/foreman',
  workerUid: 2200, slot: 0, profilePath: '/var/lib/daimon-workers/2200/.grok/sandbox.toml',
  profileSha256: '2a1dcab471092eab77565838b17a5cf138489e3daa1349612ebcedcdb69e23c4',
  denyPaths: ['/run/paideia', '/run/paideia/control', '/run/training/inputs', '/var/lib/spawnfile/daimon/grok-bootstrap-auth', '/var/lib/spawnfile/daimon/grok-subscription-realm'],
  workerConfigSha256: 'eed6a451150a72b2cb528b30c23b3d51c7d3bc38c67a8985d4dcdf956ff214d3',
  systemPromptSha256: '2c31c0085a54a4efbf9c0cf0b8124c56e47f38691b7f0c7fa233a74abaa8ddf8', grokCliVersion: '1.0.34',
  grokExecutableSha256: '39ab87666877d64ef3a40aa60fbe0c3b6a6acd7001b78fe60e2c76bb6cfc4a94', nativeAbiVersion: 2,
  model: 'grok-4.6', reasoningEffort: 'low', limits: { maxRequests: 24, maxTokens: 400000, timeoutMs: 480000 },
  usageLedgerPath: '/run/daimon-slots/0/usage/usage.jsonl', seccompProfileSha256: '7'.repeat(64),
  attestation: { platform: 'linux/landlock', enforced: true, restrictNetwork: true, profileName: 'daimon-strict', sandboxRuntime: 'bubblewrap',
    eventsPath: '/var/lib/daimon-workers/2200/.grok/sessions/sandbox-events.jsonl' },
};
export const daimonProjectionGoldenSha256 = '9e8bbd4e9337df40b90d5a382ece6c3745cb5e11038d10ea17b5032408bf30e4';

const realm = ['/var/lib/spawnfile/daimon/grok-bootstrap-auth', '/var/lib/spawnfile/daimon/grok-subscription-realm'];

/** Turns a Codex launch fixture into a Grok v2 child launch whose evaluator roots are real directories under `root`. */
export async function grokLaunchFrom<T extends NativeLaunch>(launch: T, root: string): Promise<T & GrokNativeLaunch> {
  const slot = join(root, 'slots', '0');
  const roots = { 'run-root': join(root, 'run-paideia'), context: dirname(launch.config), 'sealed-inputs': join(root, 'sealed'),
    'judge-home': join(root, 'judge-grok-home'), 'slot-ledger': join(slot, 'usage') } as const;
  for (const path of Object.values(roots)) await mkdir(path, { recursive: true, mode: 0o700 });
  const next = launch as unknown as T & GrokNativeLaunch;
  Object.assign(next, { schema: 'paideia.daimon-native.launch.v2', agent: { id: launch.agent.id, engine: 'grok', model: 'grok-4.6', reasoningEffort: 'low' },
    credentials: [], limits: { maxTokens: 8000000, wakeTokenCeiling: 1000000 },
    broker: { projectionVersion: 'noopolis.daimon.grok-broker-projection.v1', projectionSha256: '0'.repeat(64), slot: 0, workerUid: 2200,
      workerHomePath: join(slot, 'worker-home'), architecture: 'arm64', usageLedgerPath: join(roots['slot-ledger'], 'usage.jsonl'),
      seccompProfileSha256: '7'.repeat(64), limits: { maxRequests: 24, maxTokens: 400000, timeoutMs: 480000 },
      evaluatorPaths: Object.entries(roots).map(([role, path]) => ({ role, path })), slotPreflightReceipt: join(slot, 'slot-preflight.json') } });
  next.broker.projectionSha256 = grokProjectionSha256(grokProjectionFor(next));
  return next;
}

export function grokConfigFor(config: NativeConfig): NativeConfig {
  const agent = config.agents[0]!;
  agent.engine = { kind: 'grok', model: 'grok-4.6', reasoningEffort: 'low' };
  return config;
}

/** What Daimon's resolver returns for this launch when its inputs are passed through unchanged. */
export function grokProjectionFor(launch: GrokNativeLaunch, extraDeny: readonly string[] = []): GrokBrokerProjection {
  const { broker } = launch;
  const home = launch.projections.find(row => row.role === 'home')!.target;
  return { ...daimonProjectionGolden, agentId: launch.agent.id, workspacePath: launch.workspace.target, runtimeHomePath: home,
    workerUid: broker.workerUid, slot: broker.slot, profilePath: `${broker.workerHomePath}/.grok/sandbox.toml`,
    denyPaths: [...new Set([...realm, launch.controlRoot, ...broker.evaluatorPaths.map(row => row.path), ...extraDeny])].sort(),
    model: launch.agent.model, reasoningEffort: launch.agent.reasoningEffort, limits: { ...broker.limits }, usageLedgerPath: broker.usageLedgerPath,
    seccompProfileSha256: broker.seccompProfileSha256, attestation: { ...daimonProjectionGolden.attestation, eventsPath: `${broker.workerHomePath}/.grok/sessions/sandbox-events.jsonl` } };
}

export function slotPreflightFor(projection: GrokBrokerProjection, paths = projection.denyPaths): GrokSlotPreflight {
  return { version: 'noopolis.daimon.grok-slot-preflight.v1', slot: projection.slot, worker_uid: projection.workerUid,
    projection_sha256: grokProjectionSha256(projection), sandbox_profile_sha256: projection.profileSha256,
    seccomp_profile_sha256: projection.seccompProfileSha256, sandbox_runtime: 'bubblewrap', grok_executable_sha256: projection.grokExecutableSha256,
    canaries: paths.map(path => ({ path, method: 'sandboxed-read', result: 'denied' })), created_at: '2026-09-17T12:00:00.000Z' };
}

export async function writeGrokSlotReceipt(launch: GrokNativeLaunch, value: unknown = slotPreflightFor(grokProjectionFor(launch))): Promise<void> {
  await mkdir(dirname(launch.broker.slotPreflightReceipt), { recursive: true });
  await writeFile(launch.broker.slotPreflightReceipt, JSON.stringify(value));
}

export async function writeGrokProjectionReceipt(launch: VerifiedNativeLaunch & GrokNativeLaunch, trialId: string, projection = grokProjectionFor(launch)): Promise<void> {
  await writeFile(join(launch.controlRoot, 'sandbox-projection.json'),
    JSON.stringify(bindGrokBrokerProjection(projection, slotPreflightFor(projection), trialId, launch.configSha256)), { mode: 0o600 });
}
