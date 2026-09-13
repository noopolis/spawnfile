import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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
    candidateId: 'baseline', model: 'gpt-5.5', prices: standardPrices, store,
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
