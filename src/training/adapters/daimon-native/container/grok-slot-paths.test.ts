import { expect, test } from 'vitest';
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SubjectStart } from '../../../contracts/execution.js';
import { grokProjectionFor, slotPreflightFor, fixtureNonce } from '../grok-fixtures.js';
import { grokProjectionSha256, nativeTrialArtifactsRoot, sha256, type GrokBrokerProjection, type GrokNativeLaunch } from '../receipt/index.js';
import { loadNativeLaunch } from './manifest.js';

const instructions = 'Compiler-owned identity';

/**
 * The broker-capable training container's own fixed slot paths, mirrored under a
 * test root: `<slot>/{workspace,runtime-home,state}` are siblings, the control
 * root is the lifted acceptance-store mask `projection_sha256` binds and already
 * holds Daimon's own store, and every Paideia control input lives in the denied
 * `/run/paideia` evaluator root. Nothing here is inside the trial runtime home,
 * which is exactly what the Codex rules require and the container cannot give.
 */
async function slotFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'grok-slot-paths-')));
  const slot = join(root, 'run/training/slot');
  const paths = {
    workspace: join(slot, 'workspace'), runtimeHome: join(slot, 'runtime-home'), state: join(slot, 'state'),
    acceptance: join(slot, 'state/wake-acceptance'), turns: join(slot, 'turns'), usage: join(slot, 'usage'),
    runRoot: join(root, 'run/training/output'), sealed: join(root, 'run/training/inputs'),
    grants: join(root, 'run/training/grants'), controls: join(root, 'run/paideia'),
    worker: join(root, 'opt/paideia/native'),
  };
  for (const path of Object.values(paths)) await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(join(paths.workspace, 'AGENTS.md'), instructions);
  const config = JSON.stringify({ version: 'noopolis.daimon.organization-runtime.v2', agent: 'unit' });
  const files = { config: join(paths.controls, 'config.json'), token: join(paths.controls, 'token'), env: join(paths.controls, 'env') };
  await writeFile(files.config, config, { mode: 0o600 });
  await writeFile(files.token, 'unit-secret-that-is-not-a-login', { mode: 0o600 });
  await writeFile(files.env, 'TRIAL_FIXTURE=unit\n', { mode: 0o600 });
  const launch: GrokNativeLaunch = {
    schema: 'paideia.daimon-native.launch.v2', image: `sha256:${'a'.repeat(64)}`,
    config: files.config, configSha256: sha256(config), sourceConfigSha256: sha256(config),
    tokenFile: files.token, envFile: files.env, controlRoot: paths.state, workerRoot: paths.worker,
    host: { bindHost: '127.0.0.1', port: 19700 },
    agent: { id: 'agent:writer', engine: 'grok', model: 'grok-4.6', reasoningEffort: 'low' },
    instructions: { relativePath: 'AGENTS.md', sha256: sha256(instructions),
      rendering: { kind: 'trim-surround', prefix: '', suffix: '', nativeSha256: sha256(instructions) } },
    workspace: { source: paths.workspace, target: paths.workspace },
    projections: [{ role: 'home', source: paths.runtimeHome, target: paths.runtimeHome }], credentials: [],
    limits: { maxTokens: 8_000_000, wakeTokenCeiling: 1_000_000 },
    overrides: { schedule: { before: { kind: 'every', interval_ms: 60_000 }, after: { kind: 'disabled' }, reason: 'Isolated single trial' },
      selection: { before: ['agent:writer', 'agent:editor'], after: ['agent:writer'], reason: 'Selected subject only' } },
    broker: { projectionVersion: 'noopolis.daimon.grok-broker-projection.v1', projectionSha256: '0'.repeat(64), slot: 0, workerUid: 2200,
      workerHomePath: join(root, 'var/lib/daimon-workers/2200'), architecture: 'arm64', usageLedgerPath: join(paths.usage, 'usage.jsonl'),
      seccompProfileSha256: '7'.repeat(64), limits: { maxRequests: 24, maxTokens: 400_000, timeoutMs: 480_000 },
      evaluatorPaths: [{ role: 'run-root', path: paths.runRoot }, { role: 'context', path: paths.controls },
        { role: 'sealed-inputs', path: paths.sealed }, { role: 'judge-home', path: paths.grants }, { role: 'slot-ledger', path: paths.usage }],
      slotPreflightReceipt: join(slot, 'preflight.json'), expectedNonce: fixtureNonce, minGeneration: 3 },
  };
  const receiptFile = join(paths.runtimeHome, 'native-launch.json');
  const save = async (): Promise<void> => { await writeFile(receiptFile, JSON.stringify(launch), { mode: 0o600 }); await chmod(receiptFile, 0o600); };
  /** The root slot supervisor's receipt: it denies exactly the projected paths, including the control root. */
  const publish = async (projection: GrokBrokerProjection = grokProjectionFor(launch, [paths.turns])): Promise<void> => {
    launch.broker.projectionSha256 = grokProjectionSha256(projection);
    await save();
    await writeFile(launch.broker.slotPreflightReceipt,
      JSON.stringify(slotPreflightFor(projection, projection.denyPaths, launch.broker.minGeneration, launch.broker.expectedNonce)), { mode: 0o640 });
  };
  const input: SubjectStart = { trialId: 'slot-trial', workspacePath: paths.workspace, runtimeHomePath: paths.runtimeHome,
    protectedPaths: [paths.runRoot, paths.controls], instructions, model: 'grok-4.6', onObservation: () => undefined };
  await publish();
  return { root, paths, launch, input, save, publish };
}

test('the training container fixed slot paths load as a Grok child launch', async () => {
  const f = await slotFixture();
  try {
    // Neither anchor the Codex rules use is available: the control root is outside the runtime home and is not empty.
    expect(f.launch.controlRoot.startsWith(`${f.input.runtimeHomePath}/`)).toBe(false);
    expect(await readdir(f.launch.controlRoot)).toEqual(['wake-acceptance']);
    const loaded = await loadNativeLaunch(f.input, true);
    expect(loaded.controlRoot).toBe(f.paths.state);
    expect(loaded.projections).toEqual([{ role: 'home', source: f.paths.runtimeHome, target: f.paths.runtimeHome }]);
    expect(nativeTrialArtifactsRoot(loaded, f.input.trialId).startsWith(`${f.paths.state}/`)).toBe(true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a Grok control root the slot receipt does not deny to the worker uid is refused', async () => {
  const f = await slotFixture();
  try {
    const projection = grokProjectionFor(f.launch, [f.paths.turns]);
    await f.publish({ ...projection, denyPaths: projection.denyPaths.filter(path => path !== f.launch.controlRoot) });
    await expect(loadNativeLaunch(f.input, true)).rejects.toThrow('denies to the worker');
    await f.publish();
    await expect(loadNativeLaunch(f.input, true)).resolves.toBeDefined();
    // A receipt that certifies some other projection cannot speak for this launch's paths at all.
    await f.publish();
    f.launch.broker.projectionSha256 = 'c'.repeat(64); await f.save();
    await expect(loadNativeLaunch(f.input, true)).rejects.toThrow('certifies a different projection');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a Grok writable root outside the trial workspace and runtime home is refused', async () => {
  const f = await slotFixture();
  try {
    const elsewhere = join(f.root, 'run/training/slot/other-home');
    await mkdir(elsewhere, { recursive: true, mode: 0o700 });
    f.launch.projections = [{ role: 'home', source: elsewhere, target: elsewhere }];
    await f.publish();
    await expect(loadNativeLaunch(f.input, true)).rejects.toThrow('exactly the slot runtime home');
    // A second writable projection has no digest-bound slot path behind it at all.
    f.launch.projections = [{ role: 'home', source: f.paths.runtimeHome, target: f.paths.runtimeHome },
      { role: 'state', source: elsewhere, target: elsewhere }];
    await f.publish();
    await expect(loadNativeLaunch(f.input, true)).rejects.toThrow('projects exactly the slot workspace');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a Grok writable root that touches a denied slot root is refused', async () => {
  const f = await slotFixture();
  try {
    await f.publish(grokProjectionFor(f.launch, [f.paths.turns, f.paths.runtimeHome]));
    await expect(loadNativeLaunch(f.input, true)).rejects.toThrow('outside every denied slot root');
    await f.publish(grokProjectionFor(f.launch, [f.paths.turns, join(f.paths.workspace, 'sealed')]));
    await expect(loadNativeLaunch(f.input, true)).rejects.toThrow('denied slot root');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('Grok control inputs and the launch receipt stay private inside a denied slot root', async () => {
  const f = await slotFixture();
  try {
    const exposed = join(f.paths.runtimeHome, 'token');
    await writeFile(exposed, 'unit-secret-that-is-not-a-login', { mode: 0o600 });
    f.launch.tokenFile = exposed; await f.publish();
    await expect(loadNativeLaunch(f.input, true)).rejects.toThrow('private trial files');
    f.launch.tokenFile = join(f.paths.controls, 'token'); await f.publish();
    await chmod(join(f.paths.runtimeHome, 'native-launch.json'), 0o644);
    await expect(loadNativeLaunch(f.input, true)).rejects.toThrow('must stay private');
    // The supervisor receipt is the container root's statement; a world-writable one is not.
    await chmod(join(f.paths.runtimeHome, 'native-launch.json'), 0o600);
    await chmod(f.launch.broker.slotPreflightReceipt, 0o666);
    await expect(loadNativeLaunch(f.input, true)).rejects.toThrow('written by the container root');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('each Grok trial owns a fresh directory inside the shared slot control root', async () => {
  const f = await slotFixture();
  try {
    const loaded = await loadNativeLaunch(f.input, true);
    const first = nativeTrialArtifactsRoot(loaded, f.input.trialId);
    const second = nativeTrialArtifactsRoot(loaded, 'slot-trial-2');
    expect(first).not.toBe(second);
    await mkdir(first, { recursive: true, mode: 0o700 });
    // Trial N's artifacts survive the recycle, which only wipes Daimon's store; trial N+1 must not reuse them.
    await expect(loadNativeLaunch(f.input, true)).rejects.toThrow('already holds fresh trial data');
    await expect(loadNativeLaunch({ ...f.input, trialId: 'slot-trial-2' }, true)).resolves.toBeDefined();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
