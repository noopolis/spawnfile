import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataMap, ResolvedRecord } from '../../contracts/dataset.js';
import type { ArtifactSnapshot } from '../../contracts/evaluation.js';
import { snapshotCandidate } from '../../candidates/index.js';
import { openExperimentStore } from '../../storage/index.js';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';
import { createEvaluationRegistry } from '../../evaluation/index.js';
import { runStoredTrial, type StoredTrialOptions, type TrialReport } from '../trials/index.js';
import * as optimization from '../../optimization/index.js';
import { trainAgent } from './training.js';
import { trainingFeedback } from './feedback.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const article = { headline: 'Factory orders rise', body: ['Orders rose 3 percent.', 'Exports accounted for half the gain.'] };
function artifact(name: string, value: unknown): ArtifactSnapshot {
  const bytes = JSON.stringify(value);
  return { name, value, bytes, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    checkpointId: 'snapshot', provenance: 'synthetic test collector' };
}
function record(): ResolvedRecord {
  return resolveDataset(parseDatasetYaml(`schema: paideia.dataset.v1
id: writing
checks: [{id: done, eval: equals, input: output.text, value: ""}]
records: [{id: assigned-story, group: topic, input: {prompt: File the article.}}]
`)).records[0]!;
}
function report(): TrialReport {
  return { schema: 'paideia.trial.v1', id: 'trial', phase: 'train', candidateId: 'baseline', datasetDigest: 'dataset', planDigest: 'plan',
    recordId: 'assigned-story', paths: { root: '/private', workspace: '/private', control: '/private', runtimeHome: '/private' },
    status: 'pass', execution: 'completed', hostWork: 'settled', turns: [], live: [],
    snapshot: { trialId: 'trial', recordId: 'assigned-story', closed: true, output: 'Original chat answer.\n', events: [], coverage: [],
      artifacts: { hidden: artifact('hidden', 'UNDECLARED SECRET') }, inputFiles: { private: 'INPUT SECRET' }, context: { private: 'CONTEXT SECRET' } },
    evaluation: { status: 'pass', stages: [], checks: {}, scores: {} } };
}

it('preserves plain-text behavior and existing train diagnostics when no task artifacts are declared', () => {
  const selected = record(), captured = report();
  const result = trainingFeedback(selected, captured);
  expect(result.output).toBe('Original chat answer.\n');
  expect(JSON.parse(result.feedback)).toEqual({ task: selected.input, criteria: selected.effectiveStages, evaluation: { status: captured.evaluation.status, stages: [] }, subjectUsage: null, live: [] });
  expect(JSON.stringify(result)).not.toContain('SECRET');
});

it.each(['validation', 'test'] as const)('never returns output or feedback for %s even with declared artifacts', phase => {
  const selected = record(), captured = report();
  selected.outputs = { article: 'article.json' };
  captured.phase = phase; captured.snapshot.output = 'HELDOUT SECRET';
  captured.snapshot.artifacts = { ...captured.snapshot.artifacts, article: artifact('article', 'HELDOUT SECRET') };
  expect(trainingFeedback(selected, captured)).toEqual({ output: '', feedback: '' });
});

it('shows unavailable declared outputs explicitly and preserves null or text values without reading metadata', () => {
  const selected = record(), captured = report();
  selected.outputs = { missing: 'missing.json', nullable: 'null.json', note: 'note.txt', undefined: 'undefined.json', inherited: 'inherited.json' };
  captured.snapshot.artifacts = Object.assign(Object.create({ inherited: artifact('inherited', 'INHERITED SECRET') }), {
    nullable: artifact('nullable', null), note: artifact('note', 'Keep this exact text.\n'),
    undefined: { ...artifact('undefined', null), value: undefined },
  });
  expect(JSON.parse(trainingFeedback(selected, captured).output)).toEqual({ output: { text: captured.snapshot.output }, artifacts: {
    missing: { status: 'unavailable' }, nullable: { status: 'available', value: null },
    note: { status: 'available', value: 'Keep this exact text.\n' }, undefined: { status: 'unavailable' }, inherited: { status: 'unavailable' },
  } });
});

it('retains ordered-turn task feedback without exposing record references or collector parameters', () => {
  const selected = record(), captured = report();
  delete selected.input;
  selected.turns = [{ id: 'draft', input: { prompt: 'Write.' } }, { id: 'revise', input: { prompt: 'Revise.' } }];
  selected.context = { private: 'CONTEXT SECRET' };
  selected.reference = { labels: 'REFERENCE SECRET' };
  selected.setup = { profile: 'collector', artifacts: { article: { private: 'COLLECTOR SECRET' } } };
  captured.snapshot.artifacts = { ...captured.snapshot.artifacts, article: artifact('article', article) };
  const result = trainingFeedback(selected, captured);
  expect(JSON.parse(result.feedback).task).toEqual(selected.turns);
  expect(JSON.stringify(result)).not.toContain('SECRET');
});

it('feeds an actual stored trial’s file output and trusted collected article despite empty final chat', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paideia-file-feedback-')); roots.push(root);
  const source = join(root, 'source'); await mkdir(source);
  await writeFile(join(source, 'AGENTS.md'), 'File the assigned article using the prepared workspace.');
  const candidate = await snapshotCandidate({ sourceRoot: source, resources: [{ id: 'instructions', sourcePath: 'AGENTS.md',
    destinations: [{ kind: 'instructions', path: 'AGENTS.md' }], edit: 'whole-file' }] });
  const selected = record();
  selected.outputs = { draft: 'draft.json' };
  selected.setup = { profile: 'synthetic-collector', artifacts: { 'accepted-article': { collector: 'article' } } };
  const storeRoot = join(root, 'store'), store = await openExperimentStore(storeRoot);
  const native: StoredTrialOptions = { id: 'file-producing', phase: 'train', record: selected, candidate, store, storeRoot,
    datasetId: 'writing', datasetDigest: 'dataset', planDigest: 'plan', root: join(root, 'trials'), timeoutMs: 2_000, model: 'synthetic',
    registry: createEvaluationRegistry(), evaluation: { judges: {}, embeddings: {}, readText: async () => '' },
    adapter: { id: 'synthetic-file-writer', capabilities: { toolTrace: 'none', liveObservations: false, cancellation: 'native-handle', multiTurn: false,
      resources: ['instructions'], isolation: 'test fixture', readIsolation: 'declared-paths', protectedPaths: true },
      async start(input) { return {
        async run() {
          await writeFile(join(input.workspacePath, 'draft.json'), JSON.stringify(article));
          return { status: 'completed', text: '', usage: null, coverage: [{ channel: 'output', completeness: 'complete', ordering: 'source' }] };
        },
        async stop(reason) { return { state: 'acknowledged', scope: 'native-handle', quiescence: 'confirmed', remoteWork: 'unknown', reason, detail: 'synthetic writer stopped' }; },
      }; } },
    prepareEnvironment: async paths => ({ collect: async () => {
      const value = JSON.parse(await readFile(join(paths.workspace, 'draft.json'), 'utf8')) as DataMap;
      return { 'accepted-article': artifact('accepted-article', { ...value, status: 'accepted by synthetic collector' }),
        evaluatorOnly: artifact('evaluatorOnly', 'EVALUATOR SECRET') };
    } }),
  };
  const captured = await runStoredTrial(native);
  expect(captured.status).toBe('pass'); expect(captured.snapshot.output).toBe('');
  const replay = await store.readReplay(captured.id, { audience: 'operator', phase: 'replay' });
  const persisted = replay.evaluations[0]!.report as TrialReport;
  const feedback = trainingFeedback(selected, persisted);
  expect(JSON.parse(feedback.output)).toEqual({ output: { text: '' }, artifacts: {
    draft: { status: 'available', value: article },
    'accepted-article': { status: 'available', value: { ...article, status: 'accepted by synthetic collector' } },
  } });
  expect(JSON.stringify(feedback)).not.toContain('EVALUATOR SECRET');

  const dataset = (id: string) => {
    const resolved = resolveDataset(parseDatasetYaml(JSON.stringify({ schema: 'paideia.dataset.v1', id,
      checks: [{ id: 'done', eval: 'equals', input: 'output.text', value: '' }],
      records: [{ id, group: id, input: { prompt: 'File the article.' } }] })));
    resolved.records[0] = { ...selected, id, group: id };
    return resolved;
  };
  vi.spyOn(optimization, 'runDspyOptimization').mockImplementation(async request => {
    const signal = new AbortController().signal;
    const trained = await request.evaluate({ caseId: 'train', split: 'train', components: request.components }, signal);
    expect(JSON.parse(trained.output)).toEqual(JSON.parse(feedback.output));
    expect(`${trained.output}${trained.feedback}`).not.toContain('EVALUATOR SECRET');
    const validation = await request.evaluate({ caseId: 'validation', split: 'validation', components: request.components }, signal);
    expect(validation.output).toBe(''); expect(validation.feedback).toBe('');
    return { schema: 'paideia.dspy.v1', kind: 'result', id: request.id, components: request.components,
      provenance: { optimizer: 'dspy.GEPA', dspyVersion: '3.3.1', gepaVersion: '0.1.4', seed: 0,
        evaluations: 2, proposals: 0, selectedCandidateIndex: 0,
        candidates: [{ components: request.components, parents: [null], validationScore: 1, discoveryEvaluations: 0 }],
        captures: [{ caseId: 'train', split: 'train', captureId: trained.captureId },
          { caseId: 'validation', split: 'validation', captureId: validation.captureId }], generations: [] } };
  });
  const trained = await trainAgent({ id: 'file-optimization', baseline: candidate, train: dataset('train'),
    validation: dataset('validation'), test: dataset('sealed'), native,
    inference: { model: 'unused', provider: { id: 'unused', capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
      generate: async () => { throw new Error('No cognition in this fixture'); } } },
    bridge: { command: 'unused', cwd: root, timeoutMs: 2_000 }, budget: { maxMetricCalls: 4, maxProposals: 1 } });
  expect(trained.trials.map(trial => trial.phase)).toEqual(['train', 'validation', 'test']);
  expect(trained.trials.every(trial => trial.snapshot.output === '' && trial.snapshot.artifacts['accepted-article'] !== undefined)).toBe(true);
});

it('keeps criterion failures and subject cost once, excluding duplicated gates and judge accounting', () => {
  const captured = report();
  const failure = { id: 'prose', status: 'fail' as const, finality: 'final' as const, score: 0.4,
    reason: 'The ending repeats the lead.', evidence: [], usage: [{ inputTokens: 999999, cachedInputTokens: null, outputTokens: 3, reasoningTokens: null, source: 'judge' }] };
  captured.evaluation.stages = [{ id: 'writing', checks: [failure], gate: { ...failure, children: [failure] } }];
  captured.evaluation.checks = { prose: failure };
  captured.snapshot.subjectUsage = { status: 'complete', usage: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 4, reasoningTokens: null, source: 'native' } };
  captured.live = [{ checkId: 'live', boundary: 'close', result: { ...failure, children: [{ ...failure, reason: 'Useful nested failure.' }] } }];
  const feedback = JSON.parse(trainingFeedback(record(), captured).feedback);
  expect(feedback.evaluation.stages[0].checks[0].reason).toBe(failure.reason);
  expect(feedback.evaluation.stages[0].gate).toEqual({ status: 'fail' });
  expect(feedback.subjectUsage).toEqual(captured.snapshot.subjectUsage);
  expect(feedback.live[0].result.children[0].reason).toBe('Useful nested failure.');
  expect(JSON.stringify(feedback)).not.toContain('999999');
});
