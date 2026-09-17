import type { RescoreReport } from '../../experiments/replay/index.js';
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openExperimentStore } from '../../storage/index.js';
import { standardPrices, type TrialReport } from '../../experiments/index.js';
import { createProgressJournal } from './journal.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'paideia-progress-')); roots.push(root);
  const store = await openExperimentStore(root), stdout: string[] = [];
  const journal = await createProgressJournal({ id: 'experiment', datasetId: 'development', planDigest: 'plan',
    candidateId: 'baseline', model: 'gpt-5.5', prices: standardPrices, store, storeRoot: root,
    io: { cwd: root, stdout: text => { stdout.push(text); }, stderr: () => undefined } });
  return { root, store, stdout, journal };
}
function trial(): TrialReport {
  const coverage = [{ channel: 'usage' as const, completeness: 'complete' as const, ordering: 'source' as const }];
  return { schema: 'paideia.trial.v1', id: 'trial', phase: 'test', recordId: 'SEALED CASE', candidateId: 'candidate',
    datasetDigest: 'digest', planDigest: 'plan', paths: { root: '', workspace: '', control: '', runtimeHome: '' },
    status: 'pass', execution: 'completed', hostWork: 'settled',
    snapshot: { trialId: 'trial', recordId: 'SEALED CASE', closed: true, events: [], coverage, artifacts: {},
      output: 'SECRET OUTPUT', inputFiles: { reference: 'PRIVATE EVIDENCE' }, context: {} },
    turns: [{ id: 'turn', checks: [], native: { status: 'completed', text: 'SECRET OUTPUT', coverage,
      usage: { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 100, reasoningTokens: null, source: 'native' } } }],
    evaluation: { status: 'pass', checks: {}, stages: [], scores: {} }, live: [] };
}

it('persists status and observed costs without output or sealed-case payloads', async () => {
  const f = await fixture();
  await f.journal.observe({ type: 'training.started', payload: { budget: { maxMetricCalls: 3 }, test: ['SEALED CASE'] } });
  await f.journal.observe({ type: 'trial.queued', payload: { phase: 'test', candidateId: 'candidate', caseId: 'SEALED CASE' } });
  await f.journal.observe({ type: 'trial.finished', payload: trial() });
  await f.journal.observe({ type: 'trial.finished', payload: trial() });
  await f.journal.observe({ type: 'selection.frozen', payload: { selectedId: 'candidate', optimizer: { secret: 'PRIVATE EVIDENCE' } } });
  await f.journal.observe({ type: 'training.completed', payload: { secret: 'SECRET OUTPUT' } });
  await f.journal.observe({ type: 'evaluation.completed', payload: {} });
  const replay = await f.store.readReplay(f.journal.runId, { audience: 'viewer', phase: 'training' });
  expect(replay.events.at(-1)!.payload).toMatchObject({ type: 'evaluation.completed', status: 'completed' });
  const bytes = JSON.stringify(replay.events);
  for (const secret of ['SEALED CASE', 'SECRET OUTPUT', 'PRIVATE EVIDENCE']) expect(bytes).not.toContain(secret);
  expect(f.journal.summary().groups[0]!.entryCount).toBe(1);
  expect(f.journal.costs().apiEquivalentUsd?.low).toBeGreaterThan(0);
  expect(f.stdout.length).toBe(replay.events.length);
});

it('keeps completed optimizer usage and marks unreturned attempts unknown after failure', async () => {
  const f = await fixture();
  await f.journal.observe({ type: 'optimizer.generation.started', payload: { attempt: 1 } });
  await f.journal.observe({ type: 'optimizer.generation.completed', payload: { attempt: 1, model: 'claude-fable-5-1', route: 'claude-subscription',
    usage: { inputTokens: 1000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 100, reasoningTokens: null, source: 'provider' } } });
  await f.journal.observe({ type: 'optimizer.generation.started', payload: { attempt: 2 } });
  await f.journal.observe({ type: 'optimizer.generation.failed', payload: { attempt: 2 } });
  await f.journal.observe({ type: 'optimizer.generation.started', payload: { attempt: 3 } });
  const before = f.stdout.length;
  await f.journal.observe({ type: 'unrelated', payload: {} });
  expect(f.stdout.length).toBe(before);
  await f.journal.failed(new Error('Quota exhausted while evaluating SEALED CASE'));
  const costs = f.journal.costs();
  expect(costs.entries.map(entry => entry.outcome)).toEqual(['completed', 'generation-error', 'interrupted; usage unknown']);
  expect(costs.apiEquivalentUsd).toBeNull();
  expect(costs.knownSubtotalUsd.low).toBeGreaterThan(0);
  const replay = await f.store.readReplay(f.journal.runId, { audience: 'viewer', phase: 'training' });
  expect(replay.events.at(-1)!.payload).toMatchObject({ type: 'experiment.failed', error: expect.stringContaining('protected diagnostic'),
    cost: { completeness: 'incomplete', apiEquivalentUsd: null } });
  expect(JSON.stringify(replay)).not.toContain('SEALED CASE');
  expect(f.stdout.join('')).not.toContain('SEALED CASE');
  expect(JSON.stringify(replay)).not.toContain('"diagnostic":');
  const privateReplay = await f.store.readReplay(f.journal.runId, { audience: 'operator', phase: 'training' });
  const diagnosticId = (replay.events.at(-1)!.payload as { diagnosticId: string }).diagnosticId;
  const reference = (privateReplay.events.find(event => event.id === diagnosticId)!.payload as { diagnostic: Parameters<typeof f.store.readBlob>[0] }).diagnostic;
  await expect(f.store.readBlob(reference, { audience: 'optimizer', phase: 'training' })).rejects.toThrow();
  expect((await f.store.readBlob(reference, { audience: 'operator', phase: 'training' })).toString()).toContain('SEALED CASE');
});

it('does not promote a requested optimizer model to provider-reported pricing', async () => {
  const f = await fixture();
  await f.journal.observe({ type: 'optimizer.generation.completed', payload: { attempt: 1,
    model: 'claude-fable-5-1', modelBasis: 'requested-assumption', route: 'claude-subscription',
    usage: { inputTokens: 1000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 100, reasoningTokens: null, source: 'provider' } } });
  expect(f.journal.costs().apiEquivalentUsd).toBeNull();
  expect(f.journal.costs().entries[0]).toMatchObject({ model: null, requestedModel: 'claude-fable-5-1' });
});

it('accounts for every fallback attempt on completed and failed optimizer generations', async () => {
  const f = await fixture();
  const attempt = { id: 'attempt-a', ordinal: 1, providerId: 'claude-subscription', requestedModel: 'claude-fable-5-1',
    responseModel: 'claude-fable-5-1', responseRoute: 'claude-subscription', outcome: 'failed', failureKind: 'quota',
    startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z',
    usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100, reasoningTokens: null, source: 'provider' } };
  await f.journal.observe({ type: 'optimizer.generation.completed', payload: { attempt: 1,
    model: 'claude-fable-5-1', usage: attempt.usage,
    attempts: [attempt, { ...attempt, id: 'attempt-b', ordinal: 2, outcome: 'completed', failureKind: null }] } });
  await f.journal.observe({ type: 'optimizer.generation.failed', payload: { attempt: 2,
    attempts: [{ ...attempt, id: 'attempt-c' }] } });
  expect(f.journal.costs().entries).toHaveLength(3);
  expect(f.journal.costs().entries.map(entry => entry.usage?.inputTokens)).toEqual([1000, 1000, 1000]);
  const replay = await f.store.readReplay(f.journal.runId, { audience: 'viewer', phase: 'training' });
  expect(replay.events.at(-1)!.payload).toMatchObject({ type: 'optimizer.generation.failed', cost: { knownSubtotalUsd: { low: expect.any(Number) } } });
});

it('restores native, rescore and optimizer receipts once and retains their cumulative costs', async () => {
  const f = await fixture(), native = trial();
  const call = { id: 'judge-one', judge: 'prose', providerId: 'subscription', requestedModel: 'gpt-5.5',
    responseModel: 'gpt-5.5', responseRoute: 'subscription', outcome: 'completed' as const, usage: native.turns[0]!.native.usage };
  native.evaluation.judgeCalls = [call];
  const rescore: RescoreReport = { schema: 'paideia.rescore.v1', id: 'rescore', runId: native.id, scope: 'final-stages',
    notReevaluated: ['live', 'per-turn'], original: { evaluationId: 'old', digest: 'old', candidateId: native.candidateId,
      datasetDigest: 'old', planDigest: 'old', recordId: native.recordId, phase: native.phase, status: native.status },
    criteria: { datasetId: 'dataset', datasetDigest: 'digest', sharedPlanDigest: 'plan', stages: [], registryVersions: {},
      sidecarDigests: {}, inferenceRoutes: { judges: {}, embeddings: {} } },
    execution: native.execution, hostWork: native.hostWork, coverage: [], status: 'pass',
    evaluation: { ...native.evaluation, judgeCalls: [call, { ...call, id: 'judge-two' }] } };
  const restored = { generations: [{ callbackId: 'generate-2', model: 'gpt-5.5', usage: call.usage }], failedAttempts: [],
    reservations: [{ id: 'generate-2', method: 'generate', attempts: 1, settledAttempts: 1, completed: true }] };
  for (let duplicate = 0; duplicate < 2; duplicate++) {
    await f.journal.observe({ type: 'trial.restored', payload: native });
    await f.journal.observe({ type: 'trial.rescore.restored', payload: rescore });
    await f.journal.observe({ type: 'optimizer.restored', payload: restored });
  }
  await f.journal.observe({ type: 'trial.rescored', payload: rescore });
  expect(f.journal.reports()).toEqual([native]); expect(f.journal.rescores()).toEqual([rescore]);
  expect(f.journal.costs().entries.map(entry => entry.role)).toEqual(['subject', 'judge', 'judge', 'optimizer']);
  expect(f.journal.costs().knownSubtotalUsd.low).toBeGreaterThan(0);
  const replay = await f.store.readReplay(f.journal.runId, { audience: 'viewer', phase: 'training' });
  expect(JSON.stringify(replay.events)).not.toMatch(/SEALED CASE|SECRET OUTPUT|PRIVATE EVIDENCE/);
});

it('publishes the adapter-stated startup reason and a durable path for the redacted record', async () => {
  const f = await fixture();
  const diagnostic = { schema: 'paideia.daimon-native.startup-diagnostic.v1', trialId: 'trial',
    reason: 'installed Daimon lacks the Grok broker projection capability', exitCode: 1, exitSignal: null,
    redaction: 'applied' as const, streams: { stdout: '', stderr: 'boom', truncated: { stdout: false, stderr: false } },
    protectedArtifact: '/run/training/slot/state/paideia-trials/trial-x/child-diagnostics.json' };
  await f.journal.observe({ type: 'trial.finished', payload: { ...trial(), execution: 'failed', diagnostic } });
  await f.journal.failed(new Error('Experiment failed while evaluating SEALED CASE'));
  const replay = await f.store.readReplay(f.journal.runId, { audience: 'viewer', phase: 'training' });
  const failure = replay.events.at(-1)!.payload as { type: string; error: string; startupDiagnostics?: string };
  expect(failure.type).toBe('experiment.failed');
  // The operator sees what broke instead of a second run, and the raw error string stays protected.
  expect(failure.error).toBe('Experiment failed: installed Daimon lacks the Grok broker projection capability');
  expect(failure.error).not.toContain('SEALED CASE');
  // The named artifact outlives the container the trial ran in, unlike the protected capture path.
  expect(failure.startupDiagnostics).toBeDefined();
  expect(failure.startupDiagnostics!.startsWith(join(f.root, 'blobs'))).toBe(true);
  expect(JSON.parse(await readFile(failure.startupDiagnostics!, 'utf8'))).toMatchObject({
    schema: 'paideia.startup-diagnostics.v1', diagnostics: [diagnostic] });
  expect(f.stdout.join('')).not.toContain('SEALED CASE');
});

it('keeps the protected wording when no adapter published a diagnostic', async () => {
  const f = await fixture();
  await f.journal.failed(new Error('Quota exhausted while evaluating SEALED CASE'));
  const replay = await f.store.readReplay(f.journal.runId, { audience: 'viewer', phase: 'training' });
  const failure = replay.events.at(-1)!.payload as { error: string; startupDiagnostics?: string };
  expect(failure.error).toBe('Experiment failed; protected diagnostic is available to the operator.');
  expect(failure.startupDiagnostics).toBeUndefined();
  expect(JSON.stringify(replay)).not.toContain('SEALED CASE');
});
