import { describe, expect, it } from 'vitest';
import type { ViewerCheck, ViewerCostTokens, ViewerData, ViewerUsage } from '../types.js';
import { buildCockpitMetrics } from './index.js';

function candidate(id: string): ViewerData['candidates'][number] {
  return { id, parentIds: [], validationScore: null, discoveryEvaluations: 0, editablePaths: [] };
}

function check(id: string, score: number | null, status: ViewerCheck['status'] = 'pass', children: ViewerCheck[] = []): ViewerCheck {
  return { id, label: id, score, status, children, evidenceIds: [] };
}

function trial(candidateId: string, caseId: string, score: number | null = null,
  checks: ViewerCheck[] = []): ViewerData['trials'][number] {
  return { id: `${candidateId}-${caseId}`, candidateId, caseId, score, checks, status: 'completed', coverage: [], events: [] };
}

function fixture(): ViewerData {
  return { schema: 'paideia.viewer.v1', experiment: { id: 'synthetic', title: 'Synthetic', phase: 'train', status: 'running', updatedAt: 'now' },
    cases: [{ id: 'a', split: 'train' }, { id: 'b', split: 'train' }, { id: 'c', split: 'train' },
      { id: 'v', split: 'validation' }, { id: 'v2', split: 'validation' }],
    candidates: [candidate('base'), candidate('next')], trials: [], usage: [] };
}

function tokens(inputTokens: number | null = 10): ViewerCostTokens {
  return { inputTokens, cachedInputTokens: 2, cacheWriteInputTokens: 1, cacheWrite5mInputTokens: 1,
    cacheWrite1hInputTokens: 0, outputTokens: 4, reasoningTokens: 1, invalid: false };
}

type CostLine = NonNullable<NonNullable<ViewerData['costs']>['observed']>['lines'][number];

function line(role = 'subject', name = 'Agent', usage: ViewerCostTokens | null = tokens()): CostLine {
  return { role, name, usage, model: 'known-model', requestedModel: null, modelBasis: 'provider-reported', provider: null,
    route: 'subscription', outcome: 'completed', valuationStatus: 'priced', amount: { low: 1, high: 2 }, price: null };
}

describe('native candidate presentation', () => {
  it('collapses exact historical native aliases and keeps unique candidate numbering and selection', () => {
    const data = fixture();
    const base = `sha256:${'a'.repeat(64)}`;
    const next = `sha256:${'b'.repeat(64)}`;
    data.candidates = [candidate(`GEPA 0: ${base}`), candidate(`GEPA 1: ${next}`), candidate(`GEPA 2: ${next}`)];
    data.trials = [trial(base, 'a'), trial(next, 'v'), trial(next, 'a'), trial(next, 'undeclared'), trial(next, 'a')];
    data.optimizer = { name: 'GEPA', status: 'complete', evaluations: 5, proposals: 2,
      maxMetricCalls: 5, maxProposals: 2, selectedCandidateId: `GEPA 2: ${next}` };
    const model = buildCockpitMetrics(data);
    expect(model.candidates).toEqual([
      { id: base, label: 'Baseline', sourceIds: [`GEPA 0: ${base}`, base], selected: false, splits: ['train'] },
      { id: next, label: 'Candidate 1', sourceIds: [`GEPA 1: ${next}`, `GEPA 2: ${next}`, next], selected: true,
        splits: ['train', 'validation', 'unknown'] },
    ]);
    expect(model.unknownCaseTrials).toBe(1);
    expect(model.trialIndex).toEqual(data.trials.map(row => ({ id: row.id,
      candidateId: row.candidateId, split: row.caseId === 'undeclared' ? 'unknown' : row.caseId === 'v' ? 'validation' : 'train' })));
    expect(model.scores.find(score => score.split === 'unknown')).toMatchObject({ expectedCases: null });
  });

  it('uses explicit identities and never strips arbitrary colon-containing or GEPA-looking IDs', () => {
    const data = fixture();
    data.candidates = [{ ...candidate('Display identity'), nativeId: 'native' } as ViewerData['candidates'][number],
      candidate('GEPA 1: ordinary-id'), candidate('prefix: ordinary-id')];
    data.trials = [trial('native', 'a'), trial('GEPA 1: ordinary-id', 'a'), trial('ordinary-id', 'v'), trial('Display identity', 'a')];
    data.optimizer = { name: 'test', status: 'complete', evaluations: 0, proposals: 0,
      maxMetricCalls: 0, maxProposals: 0, selectedCandidateId: 'missing' };
    expect(buildCockpitMetrics(data).candidates.map(group => [group.id, group.label, group.selected])).toEqual([
      ['native', 'Baseline', false], ['GEPA 1: ordinary-id', 'Candidate 1', false],
      ['prefix: ordinary-id', 'Candidate 2', false], ['ordinary-id', 'Candidate 3', false],
    ]);
    expect(buildCockpitMetrics(data).trialIndex.at(-1)).toEqual({ id: 'Display identity-a', candidateId: 'native', split: 'train' });
  });

  it('deduplicates case declarations and makes contradictory or missing mappings unknown', () => {
    const data = fixture();
    data.cases = [{ id: 'a', split: 'train' }, { id: 'a', split: 'train' }, { id: 'b', split: 'train' },
      { id: 'b', split: 'validation' }, { id: 'b', split: 'train' }, { id: 'sealed', split: 'test' }];
    data.trials = [trial('base', 'a', 0), trial('base', 'b', 1), trial('base', 'sealed', 0.5)];
    const model = buildCockpitMetrics(data);
    expect(model.candidates[0]!.splits).toEqual(['train', 'test', 'unknown']);
    expect(model.scores.filter(score => score.candidateId === 'base')).toEqual([
      expect.objectContaining({ split: 'train', value: 0, expectedCases: 1 }),
      expect.objectContaining({ split: 'test', value: 0.5, expectedCases: 1 }),
      expect.objectContaining({ split: 'unknown', value: 1, expectedCases: null }),
    ]);
    expect(model.unknownCaseTrials).toBe(1);
    expect(model.trialIndex).toEqual([
      { id: 'base-a', candidateId: 'base', split: 'train' },
      { id: 'base-b', candidateId: 'base', split: 'unknown' },
      { id: 'base-sealed', candidateId: 'base', split: 'test' },
    ]);
  });

  it('handles absent metadata and an empty projection without fabricating scores or costs', () => {
    const data = fixture();
    data.candidates = []; data.cases = [];
    expect(buildCockpitMetrics(data)).toEqual({ candidates: [], metrics: [{ id: 'strict', label: 'Strict gated trial score', kind: 'strict' }],
      scores: [], comparisons: [], gates: [], costs: [], trialIndex: [], trialMeasurements: [], unknownCaseTrials: 0 });
    data.trials = [trial('native', 'unmapped')];
    expect(buildCockpitMetrics(data).candidates).toEqual([{ id: 'native', label: 'Baseline', sourceIds: ['native'], selected: false, splits: ['unknown'] }]);
  });
});

describe('recorded scores and paired evidence', () => {
  it('indexes only observed metric groups and candidate stages, preserving nulls and missing-stage gates', () => {
    const data = fixture();
    data.candidates.push(candidate('unobserved'));
    data.trials = [trial('base', 'a', 0, [check('base-only', 0)]),
      trial('next', 'a', null, [check('next-only', 1)]), trial('next', 'b', null),
      trial('next', 'v', 0)];
    const model = buildCockpitMetrics(data);
    expect(model.scores).toHaveLength(5);
    expect(model.scores.some(row => row.candidateId === 'unobserved')).toBe(false);
    expect(model.scores.some(row => row.candidateId === 'next' && row.metricId === 'stage:base-only')).toBe(false);
    expect(model.comparisons).toEqual([{ baselineId: 'base', candidateId: 'next', split: 'train', metricId: 'strict',
      baselineValue: null, candidateValue: null, delta: null, matchedCases: 0, expectedCases: 3 }]);
    expect(model.gates.map(row => [row.candidateId, row.split, row.stageId, row.pass, row.unknown])).toEqual([
      ['base', 'train', 'base-only', 1, 0], ['next', 'train', 'next-only', 1, 1], ['next', 'validation', 'next-only', 0, 1],
    ]);
  });

  it('averages repeats within cases and compares only the exact shared cases for each metric and split', () => {
    const data = fixture();
    data.trials = [trial('base', 'a', 0.4, [check('quality', 0.6, 'fail')]),
      trial('base', 'a', 0.8, [check('quality', 0.8)]), trial('base', 'b', null, [check('quality', 0.4)]),
      trial('next', 'a', 0.8, [check('quality', 0.9)]), trial('next', 'c', 1, [check('quality', 1)]),
      trial('base', 'v', 0.2, [check('quality', 0.2)]), trial('next', 'v2', 1, [check('quality', 1)])];
    const model = buildCockpitMetrics(data);
    const baseline = model.scores.find(score => score.candidateId === 'base' && score.split === 'train' && score.metricId === 'stage:quality')!;
    expect(baseline).toMatchObject({ value: 0.55, observedTrials: 3, trialCount: 3, observedCases: 2, expectedCases: 3 });
    const paired = model.comparisons.find(score => score.split === 'train' && score.metricId === 'stage:quality')!;
    expect(paired).toMatchObject({ baselineId: 'base', candidateId: 'next', matchedCases: 1, expectedCases: 3, baselineValue: 0.7, candidateValue: 0.9 });
    expect(paired.delta).toBeCloseTo(0.2);
    expect(model.comparisons.find(score => score.split === 'validation' && score.metricId === 'stage:quality')).toMatchObject({
      baselineValue: null, candidateValue: null, delta: null, matchedCases: 0, expectedCases: 2,
    });
    expect(model.gates.find(gate => gate.candidateId === 'base' && gate.split === 'train')).toMatchObject({ pass: 2, fail: 1, trialCount: 3, observedCases: 2 });
  });

  it('keeps raw stages, strict gated scores, duplicate named checks and numeric zero distinct', () => {
    const data = fixture();
    const named = check('grounded', 0.75);
    const anonymous = check('quality/gate', null, 'fail', [named, check('quality/gate/1', null)]);
    data.trials = [trial('base', 'a', 0, [check('quality', 0.9, 'fail', [named, anonymous]),
      check('runtime', null, 'error'), check('other', 0.1), check('missing', null)]),
    trial('next', 'a', null, [check('quality', 0, 'unknown', [check('grounded', 0)]), check('other', 0.8)])];
    const model = buildCockpitMetrics(data);
    expect(model.metrics).toEqual([
      { id: 'stage:quality', label: 'quality', kind: 'stage', stageId: 'quality' },
      { id: 'stage:other', label: 'other', kind: 'stage', stageId: 'other' },
      { id: 'check:["quality","grounded"]', label: 'quality / grounded', kind: 'check', stageId: 'quality' },
      { id: 'strict', label: 'Strict gated trial score', kind: 'strict' },
    ]);
    expect(model.scores.find(score => score.metricId === 'strict' && score.candidateId === 'base' && score.split === 'train')).toMatchObject({ value: 0, observedTrials: 1 });
    expect(model.scores.find(score => score.metricId === 'strict' && score.candidateId === 'next' && score.split === 'train')).toMatchObject({ value: null, observedTrials: 0 });
    expect(model.scores.find(score => score.metricId === 'stage:quality' && score.candidateId === 'next' && score.split === 'train')).toMatchObject({ value: 0, observedTrials: 1 });
    expect(model.scores.find(score => score.metricId.startsWith('check:') && score.candidateId === 'base' && score.split === 'train')).toMatchObject({ value: 0.75, observedTrials: 1 });
    expect(model.gates.find(gate => gate.stageId === 'runtime' && gate.candidateId === 'base' && gate.split === 'train')).toMatchObject({ error: 1, pass: 0 });
  });

  it('leaves missing, conflicting and invalid numeric observations unavailable while retaining gate statuses', () => {
    const data = fixture();
    data.trials = [trial('base', 'a', Number.NaN, [check('quality', 0.5), check('quality', 0.8),
      check('skipped', null, 'skipped'), check('invalid', Infinity)]),
    trial('base', 'b', -1, [check('quality', 0.8, 'pass', [check('named', 1), check('named', 0)])]),
    trial('base', 'c', 2), trial('next', 'a', 1, [check('quality', 0.9)])];
    const model = buildCockpitMetrics(data);
    expect(model.scores.find(score => score.candidateId === 'base' && score.split === 'train' && score.metricId === 'strict')).toMatchObject({
      value: null, observedTrials: 0, observedCases: 0, trialCount: 3,
    });
    expect(model.scores.find(score => score.candidateId === 'base' && score.split === 'train' && score.metricId.startsWith('check:'))).toMatchObject({ value: null, observedTrials: 0 });
    expect(model.comparisons.find(score => score.split === 'train' && score.metricId === 'stage:quality')).toMatchObject({ delta: null, matchedCases: 0 });
    expect(model.gates.find(gate => gate.candidateId === 'base' && gate.split === 'train' && gate.stageId === 'quality')).toMatchObject({ pass: 1, unknown: 2 });
    expect(model.gates.find(gate => gate.candidateId === 'base' && gate.split === 'train' && gate.stageId === 'skipped')).toMatchObject({ skipped: 1, unknown: 2 });
    expect(model.metrics.some(metric => metric.id === 'stage:invalid')).toBe(false);
    expect(model.trialMeasurements.slice(0, 3).map(trial => trial.values.strict)).toEqual([null, null, null]);
    expect(model.trialMeasurements[0]!.values['stage:invalid']).toBeNull();
  });

  it('recognizes generated anonymous paths under explicitly named gate roots', () => {
    const data = fixture();
    data.trials = [trial('base', 'a', 0.5, [check('quality', 0.5, 'pass', [check('quality/0', 0.5),
      check('named-gate', null, 'pass', [check('quality/gate/0', null), check('quality/authored', 0.5)])])])];
    expect(buildCockpitMetrics(data).metrics.filter(metric => metric.kind === 'check').map(metric => metric.label))
      .toEqual(['quality / named-gate', 'quality / quality/authored']);
  });

  it('does not mutate supplied data or expose raw events, evidence or undeclared fields', () => {
    const data = fixture();
    data.trials = [trial('base', 'a', 0.4, [check('quality', 0.4)])];
    data.trials[0]!.events.push({ id: 'private-event', type: 'output', timestamp: 'now', summary: 'PRIVATE' });
    Object.assign(data.trials[0]!, { hiddenReasoning: 'PRIVATE', credentials: 'PRIVATE' });
    data.trials[0]!.checks[0]!.evidenceIds = ['PRIVATE'];
    const snapshot = structuredClone(data);
    const model = buildCockpitMetrics(data);
    expect(JSON.stringify(model)).not.toContain('PRIVATE');
    model.candidates[0]!.sourceIds.push('new');
    model.metrics[0]!.label = 'changed';
    model.metrics.find(metric => metric.kind === 'strict')!.id = 'changed';
    expect(data).toEqual(snapshot);
    expect(buildCockpitMetrics(data).metrics.at(-1)!.id).toBe('strict');
  });
});

describe('recorded usage and cost groups', () => {
  it('groups recorded valuations and independent token fields without counting raw usage twice', () => {
    const data = fixture();
    data.usage = [{ purpose: 'subject', model: 'duplicate', route: null, usage: { ...tokens(900), source: 'native' } }];
    data.costs = { observed: { total: null, knownSubtotal: { low: 1, high: 2 }, completeness: 'incomplete', usageCoverage: 'incomplete',
      groups: [{ role: 'subject', name: 'Agent', entryCount: 2, amount: null, knownSubtotal: { low: 1, high: 2 } }],
      lines: [line(), { ...line('subject', 'Agent', tokens(null)), model: null, amount: null }] } };
    const [group] = buildCockpitMetrics(data).costs;
    expect(group).toMatchObject({ role: 'subject', name: 'Agent', source: 'valuation', models: ['known-model'],
      unknownModelEntries: 1, amount: null, knownSubtotal: { low: 1, high: 2 }, entryCount: 2 });
    expect(group!.tokens.inputTokens).toEqual({ value: null, knownSubtotal: 10, knownEntries: 1, entryCount: 2 });
    expect(group!.tokens.cachedInputTokens.value).toBe(4);
    expect(group!.tokens.cacheWriteInputTokens.value).toBe(2);
    expect(group!.tokens.outputTokens.value).toBe(8);
    expect(group!.tokens.reasoningTokens.value).toBe(2);
  });

  it('retains declared missing entries and empty observed groups as unknown tokens', () => {
    const data = fixture();
    data.costs = { observed: { total: null, knownSubtotal: { low: 1, high: 1 }, completeness: 'incomplete', usageCoverage: 'incomplete',
      groups: [{ role: 'judge', name: 'Judge', entryCount: 3, amount: null, knownSubtotal: { low: 0, high: 0 } },
        { role: 'empty', name: 'Empty', entryCount: 0, amount: { low: 0, high: 0 }, knownSubtotal: { low: 0, high: 0 } }],
      lines: [line('judge', 'Judge', null)] } };
    const [judge, empty] = buildCockpitMetrics(data).costs;
    expect(judge!.tokens.inputTokens).toEqual({ value: null, knownSubtotal: 0, knownEntries: 0, entryCount: 3 });
    expect(judge!.unknownModelEntries).toBe(2);
    expect(empty!.tokens.inputTokens.value).toBeNull();
    expect(empty!.amount).toEqual({ low: 0, high: 0 });
  });

  it('falls back to observed usage with unknown valuations and keeps zero different from missing or invalid fields', () => {
    const data = fixture();
    data.usage = [{ purpose: 'subject', model: 'model', route: 'subscription', usage: { ...tokens(0), source: 'native' } },
      { purpose: 'subject', model: 'model', route: null, usage: { inputTokens: 0, cachedInputTokens: null,
        outputTokens: 0, reasoningTokens: null, source: 'native' } },
      { purpose: 'optimizer', model: null, route: null, usage: null },
      { purpose: 'judge', model: null, route: null, usage: { ...tokens(-1), outputTokens: 0.5, source: 'native' } }];
    const [subject, optimizer, judge] = buildCockpitMetrics(data).costs;
    expect(subject).toMatchObject({ source: 'usage', amount: null, knownSubtotal: null, models: ['model'] });
    expect(subject!.tokens.inputTokens).toEqual({ value: 0, knownSubtotal: 0, knownEntries: 2, entryCount: 2 });
    expect(subject!.tokens.cacheWriteInputTokens).toEqual({ value: null, knownSubtotal: 1, knownEntries: 1, entryCount: 2 });
    expect(optimizer!.tokens.inputTokens.value).toBeNull();
    expect(judge!.tokens.inputTokens.knownEntries).toBe(0);
    expect(judge!.tokens.outputTokens.value).toBeNull();
  });

  it('summarizes lines without declared groups and preserves unknown unpriced subtotals', () => {
    const data = fixture();
    data.costs = { observed: { total: null, knownSubtotal: { low: 2, high: 4 }, completeness: 'incomplete', usageCoverage: 'observed-only',
      groups: [], lines: [line(), line(), { ...line('optimizer', 'Reflection'), amount: null }] } };
    const [subject, optimizer] = buildCockpitMetrics(data).costs;
    expect(subject!.amount).toEqual({ low: 2, high: 4 });
    expect(subject!.knownSubtotal).toEqual({ low: 2, high: 4 });
    expect(optimizer!.amount).toBeNull();
    expect(optimizer!.knownSubtotal).toEqual({ low: 0, high: 0 });
    subject!.amount!.low = 200;
    expect(data.costs.observed!.lines[0]!.amount!.low).toBe(1);
  });

  it('does not report an overflowing integer token sum as a complete recorded total', () => {
    const data = fixture();
    const usage: ViewerUsage = { purpose: 'subject', model: null, route: null,
      usage: { ...tokens(Number.MAX_SAFE_INTEGER), source: 'native' } };
    data.usage = [usage, usage];
    expect(buildCockpitMetrics(data).costs[0]!.tokens.inputTokens).toEqual({ value: null, knownSubtotal: null, knownEntries: 2, entryCount: 2 });
  });
});


it('retains repeated trial values in input order using the same selected-check extraction', () => {
  const data = fixture();
  data.trials = [trial('base', 'a', 0.2, [check('writing', null, 'pass', [check('prose', 0.4)])]),
    trial('base', 'a', 0.8, [check('writing', null, 'pass', [check('prose', 0.9)])]),
    trial('base', 'v', null)];
  const model = buildCockpitMetrics(data);
  expect(model.trialMeasurements.map(row => [row.candidateId, row.caseId, row.values.strict,
    row.values['check:["writing","prose"]']])).toEqual([
    ['base', 'a', 0.2, 0.4], ['base', 'a', 0.8, 0.9], ['base', 'v', null, undefined],
  ]);
  expect(model.scores.find(row => row.candidateId === 'base' && row.split === 'train' && row.metricId === 'strict')?.value).toBe(0.5);
});
