import { afterEach, expect, it, vi } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createDaimonNativeAdapter } from '../index.js';
import { childFixture } from './fixture.js';
import { startOwnedChild } from './lifecycle.js';
import { verifyChildSandbox } from './sandbox.js';
import { grokLaunchFrom } from '../grok-fixtures.js';
import { subjectStartupDiagnostic } from '../../../experiments/index.js';
vi.mock('./sandbox.js', () => ({ verifyChildSandbox: vi.fn(async () => undefined) }));
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(mode?: string) { const f = await childFixture(mode); roots.push(f.root); return f; }

it('runs a real fresh worker child with explicit environment, observed native usage and verified normal stop', async () => {
  const f = await fixture(); vi.stubEnv('UNIT_PARENT_SECRET', 'not-in-child');
  const session = await createDaimonNativeAdapter({ execution: { kind: 'child-process' } }).start(f.input);
  expect(verifyChildSandbox).toHaveBeenCalledWith(expect.objectContaining({ configSha256: f.launch.configSha256 }), f.input.trialId, f.input.protectedPaths, expect.any(AbortSignal), undefined);
  const env = JSON.parse(await readFile(join(f.launch.controlRoot, 'child-env.json'), 'utf8'));
  expect(env).toMatchObject({ fresh: true, home: f.launch.projections.find(row => row.role === 'home')!.target, transport: 'unit-transport-value' });
  const result = await session.run({ id: 'task', text: 'Assigned work' });
  expect(result).toMatchObject({ status: 'completed', usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 } });
  expect(await session.stop('Finished')).toMatchObject({ state: 'acknowledged', quiescence: 'confirmed', remoteWork: 'unknown' });
  expect(await session.stop('Again')).toMatchObject({ state: 'acknowledged' });
  expect(() => process.kill(env.pid, 0)).toThrow();
  await expect(session.run({ id: 'again', text: 'Work' })).rejects.toThrow('one delivery');
});
it('cancels pending native work honestly as unknown containment until the outer container closes', async () => {
  const f = await fixture('stall'); const session = await createDaimonNativeAdapter({ execution: { kind: 'child-process' } }).start(f.input);
  const pending = session.run({ id: 'task', text: 'Work' });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(await session.stop('Cancelled')).toMatchObject({ state: 'unknown', quiescence: 'unknown' });
  expect(await pending).toMatchObject({ status: 'cancelled', usage: null });
});
it('keeps sourced child continuation, immutable callback identity and accumulated native usage', async () => {
  const f = await fixture('blocked'); const text = 'Verified response';
  const next = vi.fn(async () => ({ id: 'answer', text, source: { kind: 'transport', id: 'answer', sha256: `sha256:${createHash('sha256').update(text).digest('hex')}` } }));
  const policy = { maxDeliveries: 1, next }; const execution = { kind: 'child-process' as const, externalInputs: policy };
  const adapter = createDaimonNativeAdapter({ execution }); policy.maxDeliveries = 999;
  const session = await adapter.start(f.input); const result = await session.run({ id: 'task', text: 'Work' });
  expect(result).toMatchObject({ status: 'completed', usage: { inputTokens: 200, outputTokens: 40 } });
  const context = next.mock.calls[0] as unknown as [Record<string, unknown>];
  expect(context[0]?.executionId).toMatch(/^child:/u); expect(context[0]).not.toHaveProperty('containerName');
  expect(await session.stop('Finished')).toMatchObject({ quiescence: 'confirmed' });
});
it('confirms a closed deferred execution without claiming the unanswered task completed', async () => {
  const f = await fixture('blocked'); const next = vi.fn(async () => null);
  const session = await createDaimonNativeAdapter({ execution: { kind: 'child-process', externalInputs: { maxDeliveries: 1, next } } }).start(f.input);
  const result = await session.run({ id: 'task', text: 'Work' });
  // The blocked receipt travels on the turn result: the caller must be able to tell this
  // closed-but-unanswered delivery from a machine failure without parsing the message.
  expect(result).toMatchObject({ status: 'failed', blocked: 'awaiting-external-input',
    error: 'Native execution completed; delivery blocked awaiting external input',
    usage: { inputTokens: 100, outputTokens: 20 }, stop: { state: 'acknowledged', quiescence: 'confirmed', reason: 'No matching external input' } });
  expect(next).toHaveBeenCalledOnce();
  expect(await session.stop('Finished')).toMatchObject({ state: 'acknowledged', quiescence: 'confirmed' });
});
/**
 * None of these may pass as a closed deferred execution, and the reason splits in
 * two. A runtime that still admits an execution is not quiet, whatever its frame
 * said; a frame whose trace failed or whose execution does not resolve leaves a
 * quiet runtime with nothing this trial can be scored from. One refusal is about
 * containment and the other about evidence, and they are published apart.
 */
it.each([
  ['blocked-failed-trace', undefined, 'terminal-unbound'],
  // Both at once, and that is not a contradiction: the runtime is still admitting an
  // execution AND its frame cannot be scored from. Each name keeps its own meaning.
  ['blocked-active', 'activity-busy', 'terminal-unbound'],
  ['blocked-wrong-execution', undefined, 'terminal-unbound'],
] as const)('does not infer closed deferred execution from %s', async (mode, cause, missing) => {
  const f = await fixture(mode); const handle = await startOwnedChild({ kind: 'child-process' }, f.launch, f.input.trialId, 1000);
  await handle.request('/trial/run', { wakeId: 'task', text: 'Work' });
  const receipt = await handle.stop('Unanswered task');
  // Never both, and never the wrong one: the name is what sends the next look at
  // this to the runtime or to the evidence.
  expect(receipt.unconfirmed).toBe(cause);
  expect(receipt.unevidenced).toBe(missing);
  expect(receipt.state).toBe(cause ? 'unknown' : 'acknowledged');
  expect(receipt.quiescence).toBe(cause ? 'unknown' : 'confirmed');
});
it.each(['bad-ready', 'bad-health', 'exit', 'overflow'])('rejects %s before a native task', async mode => {
  const f = await fixture(mode);
  await expect(createDaimonNativeAdapter({ execution: { kind: 'child-process' }, startupMs: 150 }).start(f.input)).rejects.toThrow();
});
it('does not confirm native closure for bad-stop', async () => {
  const f = await fixture('bad-stop'); const session = await createDaimonNativeAdapter({ execution: { kind: 'child-process' } }).start(f.input);
  expect((await session.run({ id: 'task', text: 'Work' })).status).toBe('completed');
  expect(await session.stop('Finished')).toMatchObject({ quiescence: 'unknown', unconfirmed: 'native-stop-unacknowledged' });
});
/**
 * A frame carrying another trial's identity is refused as this trial's evidence —
 * the check moved out of the closure predicate, it did not go away — and the
 * runtime it came from is still, separately, proven quiet.
 */
it('refuses a foreign trial frame as evidence without doubting the runtime it came from', async () => {
  const f = await fixture('bad-terminal'); const session = await createDaimonNativeAdapter({ execution: { kind: 'child-process' } }).start(f.input);
  const result = await session.run({ id: 'task', text: 'Work' });
  expect(result.status).toBe('failed');
  expect(result.error).toContain('Native terminal evidence identity mismatch');
  const receipt = await session.stop('Finished');
  expect(receipt).toMatchObject({ state: 'acknowledged', quiescence: 'confirmed', unevidenced: 'terminal-unbound' });
  expect(receipt.unconfirmed).toBeUndefined();
});
it('rejects unsupported modes, Docker callback mixing, invalid deadlines and cancelled preparation', async () => {
  const f = await fixture();
  expect(() => createDaimonNativeAdapter({ execution: { kind: 'child-process' }, externalInputs: { maxDeliveries: 1, next: async () => null } })).toThrow('execution.externalInputs');
  expect(() => createDaimonNativeAdapter({ execution: { kind: 'wrong' as 'child-process' } })).toThrow('Unsupported');
  expect(() => createDaimonNativeAdapter({ execution: { kind: 'child-process' }, docker: vi.fn() })).toThrow('one native execution');
  await expect(startOwnedChild({ kind: 'child-process' }, f.launch, f.input.trialId, 1000, undefined, 0)).rejects.toThrow('deadline');
  await expect(startOwnedChild({ kind: 'child-process' }, f.launch, f.input.trialId, 1000, AbortSignal.abort())).rejects.toThrow();
  await expect(startOwnedChild({ kind: 'child-process', prepare: () => new Promise(() => undefined) }, f.launch, f.input.trialId, 1000, undefined, 10)).rejects.toThrow('preparation cancelled');
});

it('handles bootstrap diagnostics and preserves unknown closure after forced worker kill', async () => {
  const f = await fixture('noisy'); const handle = await startOwnedChild({ kind: 'child-process' }, f.launch, f.input.trialId, 1000);
  await handle.request('/trial/run', { wakeId: 'task', text: 'Work' }); expect((await handle.stop('Finished')).quiescence).toBe('confirmed');
  await expect(handle.request('/trial/run', { wakeId: 'late', text: 'Work' })).rejects.toThrow('no longer alive');
  const g = await fixture('ignore-term'); const forced = await startOwnedChild({ kind: 'child-process' }, g.launch, g.input.trialId, 1000);
  await forced.request('/trial/run', { wakeId: 'task', text: 'Work' }); expect((await forced.stop('Finish')).quiescence).toBe('unknown');
});
it('rejects actual spawn failure without borrowing another process or claiming containment', async () => {
  const f = await fixture(); f.launch.workerRoot = join(f.root, 'missing-parent/worker');
  await expect(startOwnedChild({ kind: 'child-process' }, f.launch, f.input.trialId, 1000)).rejects.toThrow('before readiness');
  expect(JSON.parse(await readFile(join(f.launch.controlRoot, 'child-diagnostics.json'), 'utf8'))).toMatchObject({ trialId: f.input.trialId });
});

it('cancels a pending external research callback without emitting an input or a second wake', async () => {
  const f = await fixture('blocked'); let signal!: AbortSignal; const inputs: unknown[] = [];
  f.input.onObservation = event => { if (event.type === 'input') inputs.push(event); };
  const next = vi.fn((_context: unknown, value: AbortSignal) => { signal = value; return new Promise<null>(() => undefined); });
  const session = await createDaimonNativeAdapter({ execution: { kind: 'child-process', externalInputs: { maxDeliveries: 1, next } } }).start(f.input);
  const pending = session.run({ id: 'task', text: 'Work' }); await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
  await session.stop('Stop research'); expect(signal.aborted).toBe(true);
  expect(await pending).toMatchObject({ status: 'cancelled', usage: { inputTokens: 100 } }); expect(inputs).toEqual([]);
});
it('retains cancellation and metering when operator stops while observing a verified blocked wake', async () => {
  const f = await fixture('blocked'); const next = vi.fn(async () => null);
  f.input.onObservation = async event => { if (event.type === 'diagnostic') await session.stop('Stop observed wake'); };
  const session = await createDaimonNativeAdapter({ execution: { kind: 'child-process', externalInputs: { maxDeliveries: 1, next } } }).start(f.input);
  expect(await session.run({ id: 'task', text: 'Work' })).toMatchObject({ status: 'cancelled', usage: { inputTokens: 100 } });
  expect(next).not.toHaveBeenCalled();
});

it('persists the actual pre-readiness stderr failure and publishes a redacted account of it', async () => {
  const f = await fixture('exit');
  const caught = await startOwnedChild({ kind: 'child-process' }, f.launch, f.input.trialId, 1000).then(() => new Error('startup unexpectedly succeeded'), (error: unknown) => error as Error);
  // The operator-facing error names the worker's own reason, never the runtime-local capture path.
  expect(caught.message).toBe('Native worker failed before readiness: paideia.daimon-native.start-failed.v1: unit missing native library');
  expect(caught.message).not.toContain(f.launch.controlRoot);
  const diagnostic = subjectStartupDiagnostic(caught)!;
  expect(diagnostic).toMatchObject({ schema: 'paideia.daimon-native.startup-diagnostic.v1', trialId: f.input.trialId,
    reason: 'paideia.daimon-native.start-failed.v1: unit missing native library', exitCode: 1, exitSignal: null, redaction: 'applied',
    protectedArtifact: join(f.launch.controlRoot, 'child-diagnostics.json') });
  const saved = JSON.parse(await readFile(join(f.launch.controlRoot, 'child-diagnostics.json'), 'utf8'));
  expect(saved).toMatchObject({ trialId: f.input.trialId, configSha256: f.launch.configSha256, exitCode: 1 });
  expect(JSON.parse(saved.stderr)).toMatchObject({ schema: 'paideia.daimon-native.start-failed.v1', error: 'unit missing native library' });
  // The protected capture keeps the declared transport secret; the published streams never do.
  expect(saved.stdout + saved.stderr).not.toContain('unit-transport-value');
  expect(JSON.stringify(diagnostic)).not.toContain('unit-transport-value');
});

it('withholds published streams that carry a credential nobody declared, keeping the failure class', async () => {
  const f = await fixture('leak');
  const caught = await startOwnedChild({ kind: 'child-process' }, f.launch, f.input.trialId, 1000)
    .then(() => new Error('startup unexpectedly succeeded'), (error: unknown) => error as Error);
  const diagnostic = subjectStartupDiagnostic(caught)!;
  expect(diagnostic.redaction).toBe('withheld');
  expect(diagnostic.streams).toBeUndefined();
  // The class survives even though the bytes cannot: the worker's own frame still states the reason.
  expect(diagnostic.reason).toBe('paideia.daimon-native.start-failed.v1: unit missing native library');
  expect(diagnostic.frames).toEqual(expect.arrayContaining([
    { stream: 'stderr', schema: 'paideia.daimon-native.start-failed.v1', message: 'unit missing native library' }]));
  expect(diagnostic.withheld).toEqual([{ stream: 'stderr', bytes: expect.any(Number), lines: expect.any(Number),
    frame: 'paideia.daimon-native.start-failed.v1', detectors: ['bearer', 'opaque-run'] }]);
  expect(JSON.stringify(diagnostic)).not.toContain('sk-unit-');
  const saved = JSON.parse(await readFile(join(f.launch.controlRoot, 'child-diagnostics.json'), 'utf8'));
  expect(saved.stderr).toContain('sk-unit-');
});

it.each(['bad-model', 'bad-effort'])('requires the Grok ready line to match the launch model and effort: %s', async mode => {
  const good = await fixture(); await grokLaunchFrom(good.launch, good.root); await good.save();
  const handle = await startOwnedChild({ kind: 'child-process' }, good.launch, good.input.trialId, 1000);
  await handle.stop('Ready identity accepted');
  const f = await fixture(mode); await grokLaunchFrom(f.launch, f.root); await f.save();
  await expect(startOwnedChild({ kind: 'child-process' }, f.launch, f.input.trialId, 1000, undefined, 300)).rejects.toThrow();
  if (mode === 'bad-model') {
    const codex = await fixture(mode);
    await expect(startOwnedChild({ kind: 'child-process' }, codex.launch, codex.input.trialId, 1000, undefined, 300)).rejects.toThrow();
  }
});
