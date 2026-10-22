import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AtomicFeedback, AtomicGradeResult } from '../../graders/atomic/index.js';
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
function atomicGrade(feedback: AtomicFeedback): AtomicGradeResult {
  return { schema: 'paideia.atomic-grade.v1', status: 'fail', score: 0, coverage: 1,
    criticalGate: 0, obligationCoverage: 1, quality: 0.2,
    identity: { definitionDigest: 'a'.repeat(64), templatesDigest: 'a'.repeat(64),
      outputDigest: 'a'.repeat(64), contextDigest: 'a'.repeat(64) },
    checks: [], extraction: { receipts: [{ response_text: 'PROTECTED SECRET' }], judgeCalls: [] },
    receipts: [], feedback, judgeCalls: [] };
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

it.each([false, true])('reserves every declared article before oversized chat (large artifacts=%s)', large => {
  const selected = record(), captured = report();
  selected.outputs = { draft: 'draft.json', missing: 'missing.json' };
  selected.setup = { profile: 'collector', artifacts: { accepted: { collector: 'article' } } };
  captured.snapshot.output = 'Optional chat: ' + '😀\\"'.repeat(17000);
  const draft = large ? { headline: 'Draft article begins', body: '😀\\"'.repeat(20000) } : article;
  const accepted = large ? { headline: 'Accepted article begins', body: 'é'.repeat(20000) } : { ...article, accepted: true };
  captured.snapshot.artifacts = { ...captured.snapshot.artifacts, draft: artifact('draft', draft), accepted: artifact('accepted', accepted) };
  const before = structuredClone(captured);
  const output = trainingFeedback(selected, captured).output;
  const parsed = JSON.parse(output);
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(16384);
  expect(parsed.truncated).toBe(true);
  expect(parsed.artifacts.missing).toEqual({ status: 'unavailable' });
  if (large) {
    expect(parsed.artifacts.draft.value).toMatchObject({ truncated: true });
    expect(parsed.artifacts.draft.value.excerpt).toContain('Draft article begins');
    expect(parsed.artifacts.accepted.value.excerpt).toContain('Accepted article begins');
  } else {
    expect(parsed.artifacts.draft.value).toEqual(draft);
    expect(parsed.artifacts.accepted.value).toEqual(accepted);
  }
  expect(parsed.output.text).toContain('Optional chat:');
  expect(output).not.toContain('SECRET');
  expect(captured).toEqual(before);
});

it('refuses unrepresentable structured evidence instead of silently dropping identifiers or measurements', () => {
  const selected = record(), captured = report();
  selected.outputs = { ['article'.repeat(3000)]: 'article.json' };
  expect(() => trainingFeedback(selected, captured)).toThrow('artifact identifiers');
  delete selected.outputs;
  selected.input = { prompt: 'p'.repeat(40000) };
  captured.evaluation.stages = Array.from({ length: 1000 }, (_, i) => ({ id: `stage-${i}`, checks: [{
    id: `criterion-${i}`, status: 'fail' as const, finality: 'final' as const, score: 0.3, reason: 'failure', evidence: [],
  }], gate: { status: 'fail' as const, finality: 'final' as const, reason: 'fail', evidence: [] } }));
  expect(() => trainingFeedback(selected, captured)).toThrow('Structured training feedback');
});

it('keeps nested measurements, stage weights and live atomic failures outside oversized prose', () => {
  const selected = record(), captured = report();
  selected.input = { prompt: 'p'.repeat(40000) };
  const atomic = { failed_check_count: 1, omitted_failed_checks: 0,
    failed_checks: [{ template: 'evidence', unit: 'No evidence observed.', probability: null }] };
  const leaf = { id: 'leaf', status: 'fail' as const, score: 0.3, finality: 'final' as const, reason: 'failure', evidence: [] };
  const parent = { ...leaf, id: 'parent', children: [leaf] };
  const score = { finality: 'final' as const, lower: 0.3, upper: 0.3, assessedWeight: 2, missingWeight: 0 };
  captured.evaluation.stages = [{ id: 'writing', checks: [parent], gate: parent, weights: { parent: 2 }, score }];
  const liveResult = { ...leaf, atomicGrading: atomicGrade(atomic) };
  captured.live = [{ checkId: 'live', boundary: 'close', result: liveResult }];
  const before = structuredClone(captured);
  const feedback = JSON.parse(trainingFeedback(selected, captured).feedback);
  expect(feedback.evaluation.stages[0]).toMatchObject({ weights: { parent: 2 }, score,
    checks: [{ id: 'parent', score: 0.3, children: [{ id: 'leaf', status: 'fail', score: 0.3 }] }] });
  expect(feedback.live[0]).toMatchObject({ checkId: 'live', boundary: 'close', result: { id: 'leaf', score: 0.3 } });
  expect(feedback.atomic).toEqual(atomic);
  expect(captured).toEqual(before);
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
    return { schema: 'paideia.dspy.v2', kind: 'result', id: request.id, components: request.components,
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

it('projects only the public atomic feedback, including missing probabilities, and never mutates the grade', () => {
  const captured = report();
  const atomic = { failed_check_count: 3, omitted_failed_checks: 1, failed_checks: [
    { template: 'attribution', unit: 'The report states a claim without a named source.', probability: 0.15 },
    { template: 'evidence', unit: 'No evidence observed.', probability: null },
  ] };
  const check = { id: 'writing', status: 'fail' as const, finality: 'final' as const, score: 0.3,
    reason: 'Atomic criteria failed.', evidence: [], atomicGrading: atomicGrade(atomic) };
  captured.evaluation.stages = [{ id: 'writing', checks: [check], gate: check }];
  const before = structuredClone(captured);
  const feedback = JSON.parse(trainingFeedback(record(), captured).feedback);
  expect(feedback.evaluation.stages[0].checks[0].atomic).toEqual(atomic);
  expect(JSON.stringify(feedback)).not.toContain('SECRET');
  expect(captured).toEqual(before);
  captured.phase = 'validation';
  expect(trainingFeedback(record(), captured)).toEqual({ output: '', feedback: '' });
});

it('caps atomic feedback and article excerpts by wire bytes, including JSON escapes and multibyte text', () => {
  const captured = report(), selected = record();
  const unit = '😀\\"'.repeat(1000);
  const atomic = { failed_check_count: 100, omitted_failed_checks: 0,
    failed_checks: Array.from({ length: 100 }, (_, i) => ({ template: `check-${i}`, unit, probability: i === 0 ? null : 0.2 })) };
  const check = { status: 'fail' as const, finality: 'final' as const, score: 0.2, reason: 'Failed checks', evidence: [],
    atomicGrading: atomicGrade(atomic) };
  captured.evaluation.stages = [{ id: 'writing', checks: [check], gate: check }];
  captured.snapshot.output = `Article beginning: ${unit.repeat(50)}`;
  const result = trainingFeedback(selected, captured);
  const feedback = JSON.parse(result.feedback).evaluation.stages[0].checks[0].atomic;
  expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(16384);
  expect(Buffer.byteLength(JSON.stringify(feedback))).toBeLessThanOrEqual(8192);
  expect(feedback.failed_checks.length).toBeGreaterThan(0);
  expect(feedback.failed_checks[0]).toMatchObject({ template: 'check-0', probability: null });
  expect(feedback.failed_checks[0].unit.length).toBeLessThanOrEqual(1000);
  expect(feedback.omitted_failed_checks + feedback.failed_checks.length).toBe(100);
  expect(JSON.parse(result.output)).toMatchObject({ truncated: true, originalBytes: Buffer.byteLength(captured.snapshot.output) });
  expect(JSON.parse(result.output).excerpt).toContain('Article beginning:');
  selected.input = { prompt: unit.repeat(100) };
  const large = trainingFeedback(selected, captured);
  expect(Buffer.byteLength(large.feedback)).toBeLessThanOrEqual(32768);
  expect(JSON.parse(large.feedback).truncated).toBe(true);
  expect(JSON.parse(large.feedback).atomic.failed_checks[0]).toMatchObject({ template: 'check-0', probability: null });
  expect(atomic.failed_checks).toHaveLength(100);
});

it('enforces the atomic count and unit limits even when the byte budget has room', () => {
  const captured = report();
  const check = { status: 'fail' as const, finality: 'final' as const, reason: 'Failures', evidence: [],
    atomicGrading: atomicGrade({ failed_check_count: 50, omitted_failed_checks: 0,
      failed_checks: Array.from({ length: 50 }, () => ({ template: 'tiny', unit: 'x', probability: 0 })) }) };
  captured.evaluation.stages = [{ id: 'writing', checks: [check], gate: check }];
  const projected = JSON.parse(trainingFeedback(record(), captured).feedback).evaluation.stages[0].checks[0].atomic;
  expect(projected.failed_checks).toHaveLength(40);
  expect(projected.omitted_failed_checks).toBe(10);
});

it.each([12000, 60000])('retains atomic failures through both compaction layers with %i-character criteria and reasons', size => {
  const selected = record(), captured = report();
  selected.input = { prompt: 'Task criteria: ' + 'c'.repeat(size) };
  const atomic = { failed_check_count: 2, omitted_failed_checks: 0, failed_checks: [
    { template: 'attribution', unit: 'The claim has no named source.', probability: 0.15 },
    { template: 'evidence', unit: 'No evidence observed.', probability: null },
  ] };
  const long = { id: 'earlier-check', status: 'fail' as const, finality: 'final' as const, score: 0.25, reason: 'r'.repeat(size), evidence: [] };
  const failed = { ...long, id: 'atomic-check', reason: 'Atomic failure.', atomicGrading: atomicGrade(atomic) };
  captured.evaluation.stages = [{ id: 'writing', checks: [long, failed], gate: failed }];
  captured.snapshot.subjectUsage = { status: 'complete', usage: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 4, reasoningTokens: null, source: 'native' } };
  selected.outputs = { draft: 'draft.json', accepted: 'accepted.json' };
  captured.snapshot.output = 'Optional chat: ' + 'x'.repeat(17000);
  captured.snapshot.artifacts = { ...captured.snapshot.artifacts,
    draft: artifact('draft', { headline: 'Article beginning: draft', body: '😀\\"'.repeat(10000) }),
    accepted: artifact('accepted', { headline: 'Article beginning: accepted', body: 'é'.repeat(10000) }) };
  const projected = trainingFeedback(selected, captured);
  expect(Buffer.byteLength(projected.feedback)).toBeLessThanOrEqual(32768);
  expect(JSON.parse(projected.feedback).truncated === true).toBe(size === 60000);
  // Use the actual Python Session and planning/realization generation callbacks.
  const script = `
import json, sys
from paideia_dspy.fixtures_test import request
from paideia_dspy.session import Session
from paideia_dspy.search.variants import plan, realize
source = json.load(sys.stdin)
payloads = []
def host(method, params):
    if method == "evaluate":
        return {**source, "score": 0.2, "captureId": params["caseId"]}
    payload = json.loads(params["messages"][1]["content"])
    payloads.append(payload)
    hypothesis = {"strategy": "rewrite", "hypothesis": "Name the source.",
                  "targetedCriteria": ["attribution"], "plan": "Require named attribution."}
    body = {"hypotheses": [hypothesis]} if payload["phase"] == "planning" else {
        "components": payload["currentComponents"], "hypothesis": hypothesis["hypothesis"],
        "expectedImpact": [{"criterion": "attribution", "effect": "Fewer unsourced claims."}]}
    return {"text": json.dumps(body), "model": "fixture", "usage": None}
session = Session(request(trainCaseIds=["first", "second"],
    search={"variants": 1, "keep": 1, "rounds": 1}), host)
before = source.copy()
feedback = {case: session.evaluate(case, session.request.components) for case in session.request.trainCaseIds}
hypothesis = plan(session, session.request.components, feedback, ["rewrite"])[0]
realize(session, session.request.components, feedback, hypothesis, None)
assert source == before
assert all(item["result"]["feedback"] == source["feedback"] for item in session.results[:2])
print(json.dumps(payloads))
`;
  const payloads = JSON.parse(execFileSync(resolve('bridges/dspy/.venv/bin/python'), ['-c', script], {
    cwd: resolve('bridges/dspy'), input: JSON.stringify(projected), encoding: 'utf8', timeout: 30000, maxBuffer: 2_000_000,
  }));
  expect(payloads.map((payload: { phase: string }) => payload.phase)).toEqual(['planning', 'realization']);
  for (const payload of payloads) {
    for (const field of ['trainingFeedback', 'trajectory']) {
      const view = payload[field];
      expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(65536);
      expect(view.omittedEntries).toBe(0);
      expect(view.entries.map((row: { caseId: string }) => row.caseId)).toEqual(['first', 'second']);
      for (const row of view.entries) expect(row.measurements.atomic).toEqual(atomic);
      for (const row of view.entries) {
        expect(row.measurements.criteria).toEqual([
          { stage: 'writing', id: 'earlier-check', status: 'fail', score: 0.25 },
          { stage: 'writing', id: 'atomic-check', status: 'fail', score: 0.25 },
        ]);
        expect(row.measurements.subjectUsage).toEqual(captured.snapshot.subjectUsage);
      }
    }
    for (const row of payload.trainingFeedback.entries) {
      expect(JSON.stringify(row.output.artifacts.draft.value)).toContain('Article beginning: draft');
      expect(JSON.stringify(row.output.artifacts.accepted.value)).toContain('Article beginning: accepted');
    }
  }
}, 30000);

it('passes only compact atomic failures to optimization, preserving protected receipts in the report', () => {
  const captured = report();
  const feedback = { failed_check_count: 1, omitted_failed_checks: 0,
    failed_checks: [{ template: 'supported', unit: 'An observed claim.', probability: 0.2 }] };
  const atomicGrading: import('../../graders/atomic/index.js').AtomicGradeResult = {
    schema: 'paideia.atomic-grade.v1', status: 'fail', score: 0, coverage: 1, criticalGate: 0, obligationCoverage: 1, quality: 0.2,
    identity: { definitionDigest: 'a'.repeat(64), templatesDigest: 'a'.repeat(64), outputDigest: 'a'.repeat(64), contextDigest: 'a'.repeat(64) },
    checks: [], extraction: { receipts: [{ response_text: 'PROTECTED RECEIPT'.repeat(200_000) }], judgeCalls: [] }, receipts: [], feedback, judgeCalls: [],
  };
  captured.evaluation.stages = [{ id: 'terminal', checks: [{ id: 'quality', status: 'fail', finality: 'final', reason: 'Failed', evidence: [], atomicGrading }],
    gate: { status: 'fail', finality: 'final', reason: 'Failed', evidence: [] } }];
  const result = trainingFeedback(record(), captured);
  expect(JSON.parse(result.feedback).evaluation.stages[0].checks[0].atomic).toEqual(feedback);
  expect(Buffer.byteLength(result.feedback)).toBeLessThan(2000);
  expect(result.feedback).not.toContain('PROTECTED RECEIPT');
  expect(captured.evaluation.stages[0]!.checks[0]!.atomicGrading!.extraction.receipts).toEqual(atomicGrading.extraction.receipts);
});
