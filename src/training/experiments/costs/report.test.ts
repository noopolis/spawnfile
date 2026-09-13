import { describe, expect, it } from 'vitest';
import type { EvaluationResult, JudgeCall } from '../../contracts/evaluation.js';
import type { Observation, Usage } from '../../contracts/execution.js';
import type { TrialReport } from '../trials/index.js';
import { summarizeCosts } from './report.js';
import type { ModelPrice } from './types.js';

const usage: Usage = { inputTokens: 100, cachedInputTokens: 20, cacheWriteInputTokens: 0,
  outputTokens: 10, reasoningTokens: 4, source: 'native' };
const prices: ModelPrice[] = ['subject-model', 'judge-model', 'other-model'].map((model, index) => ({
  model, vendor: 'synthetic', currency: 'USD', source: 'synthetic fixture', checkedAt: '2026-09-13', scope: 'Test rates.',
  perMillion: { input: 10 * (index + 1), cacheRead: 1 * (index + 1), output: 20 * (index + 1) },
}));
const options = { subjectModel: 'subject-model', prices };
const usageEvent = (id: string, value = usage, wakeId = 'task'): Observation => ({
  id, source: 'native', seq: 1, type: 'usage', timestamp: 'now', trialId: 'trial-1', wakeId, usage: value,
});
function check(calls: JudgeCall[] = []): EvaluationResult {
  return { status: 'pass', finality: 'final', reason: 'Synthetic judgment', evidence: [], judgeCalls: calls,
    usage: calls.flatMap(call => call.usage === null ? [] : [call.usage]) };
}
function judge(id: string, overrides: Partial<JudgeCall> = {}): JudgeCall {
  return { id, judge: 'prose', providerId: 'subscription-judge', requestedModel: 'requested-alias',
    responseModel: 'judge-model', responseRoute: 'subscription', outcome: 'completed', usage, ...overrides };
}
function trial(id = 'trial-1'): TrialReport {
  return { schema: 'paideia.trial.v1', id, phase: 'train', candidateId: 'baseline', datasetDigest: 'dataset',
    planDigest: 'plan', recordId: 'record', paths: { root: '/trial', workspace: '/trial/work', control: '/trial/control', runtimeHome: '/trial/runtime' },
    status: 'pass', execution: 'completed', hostWork: 'settled',
    turns: [{ id: 'task', native: { status: 'completed', text: 'Answer',
      coverage: [{ channel: 'usage', completeness: 'complete', ordering: 'source' }], usage }, checks: [] }],
    snapshot: { trialId: id, recordId: 'record', closed: true, events: [],
      coverage: [{ channel: 'usage', completeness: 'complete', ordering: 'source' }], artifacts: {}, output: 'Answer', inputFiles: {}, context: {} },
    evaluation: { status: 'pass', stages: [], checks: {}, scores: {} }, live: [] };
}

describe('recorded experiment cost report', () => {
  it('prices terminal native usage once and discloses requested-model attribution', () => {
    const input = trial();
    input.snapshot.events = [{ id: 'usage-duplicate', type: 'usage', seq: 1, source: 'native', timestamp: 'now', trialId: input.id,
      wakeId: 'task', usage }];
    const before = structuredClone(input);
    const report = summarizeCosts([input], options);
    expect(report).toMatchObject({ schema: 'paideia.cost-report.v1', currency: 'USD', completeness: 'complete', usageCoverage: 'observed-only',
      subscriptionChargeUsd: null, apiEquivalentUsd: { low: 0.00102, high: 0.00102 } });
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({ role: 'subject', name: 'subject', model: 'subject-model',
      modelBasis: 'requested-assumption', requestedModel: 'subject-model', usage });
    expect(report.warnings.some(value => value.includes('not verified'))).toBe(true);
    expect(input).toEqual(before);
  });

  it('deduplicates judge IDs across plan, nested gates, turn checks and live attempts', () => {
    const input = trial(), first = judge('call-a'), second = judge('call-b', { judge: 'facts', responseModel: 'other-model' });
    input.evaluation.judgeCalls = [first];
    input.evaluation.checks = { quality: check([first]) };
    input.evaluation.stages = [{ id: 'quality', checks: [check([first])], gate: { ...check(), children: [check([second])] } }];
    input.turns[0]!.checks = [check([first])];
    input.live = [{ checkId: 'prose', boundary: 'event-a', result: check([first]) },
      { checkId: 'facts', boundary: 'event-b', result: check([second]) }];
    input.decisiveFailure = check([second]);
    const report = summarizeCosts([input, structuredClone(input)], options);
    const calls = report.entries.filter(entry => entry.role === 'judge');
    expect(calls).toHaveLength(2);
    expect(calls.map(call => [call.name, call.model, call.providerId, call.requestedModel])).toEqual([
      ['prose', 'judge-model', 'subscription-judge', 'requested-alias'],
      ['facts', 'other-model', 'subscription-judge', 'requested-alias'],
    ]);
    expect(calls.every(call => call.modelBasis === 'provider-reported')).toBe(true);
    expect(report.apiEquivalentUsd!.low).toBeCloseTo(0.00612);
    expect(report.groups.map(group => [group.role, group.name, group.entryCount])).toEqual([
      ['subject', 'subject', 1], ['judge', 'prose', 1], ['judge', 'facts', 1],
    ]);
  });

  it('retains invalid judge output usage and reports generation failures as unknown', () => {
    const input = trial();
    input.evaluation.judgeCalls = [judge('invalid', { outcome: 'invalid-response' }),
      judge('failed', { outcome: 'generation-error', responseModel: null, responseRoute: null, usage: null })];
    const report = summarizeCosts([input], options);
    expect(report.apiEquivalentUsd).toBeNull();
    expect(report.knownSubtotalUsd.low).toBeCloseTo(0.00306);
    expect(report.completeness).toBe('incomplete');
    expect(report.entries[1]).toMatchObject({ outcome: 'invalid-response', usage, valuation: { status: 'priced' } });
    expect(report.entries[2]).toMatchObject({ outcome: 'generation-error', model: null, usage: null,
      valuation: { status: 'incomplete', apiEquivalentUsd: null } });
    expect(report.groups.find(group => group.role === 'judge')).toMatchObject({ completeness: 'incomplete', apiEquivalentUsd: null });
  });

  it('retains legacy usage without inventing its model or distinct call count', () => {
    const input = trial(), legacy = { ...check(), judgeCalls: undefined, usage: [usage, usage] };
    input.evaluation.checks = { legacy, known: check([judge('known')]) };
    input.live = [{ checkId: 'legacy', boundary: 'event', result: structuredClone(legacy) }];
    const report = summarizeCosts([input], options);
    const unknown = report.entries.filter(entry => entry.role === 'unattributed');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({ model: null, usage: null, modelBasis: 'unknown' });
    expect(unknown[0]!.observedUsageReports).toHaveLength(2);
    expect(unknown[0]!.observedUsageReports![0]!.usage).toEqual([usage, usage]);
    expect(report.apiEquivalentUsd).toBeNull();
    expect(report.warnings.some(value => value.includes('distinct call count'))).toBe(true);
  });

  it('does not mistake metadata-backed compatibility usage for another billed call', () => {
    const input = trial(), named = judge('call-a');
    input.evaluation.checks = { composed: { ...check(), children: [check([named])], usage: [usage] } };
    const report = summarizeCosts([input], options);
    expect(report.entries.map(entry => entry.role)).toEqual(['subject', 'judge']);
    expect(report.completeness).toBe('complete');
  });

  it('keeps unmatched legacy usage even alongside attributed identical usage', () => {
    const input = trial();
    input.evaluation.checks = { mixed: { ...check([judge('one')]), usage: [usage, usage] } };
    const report = summarizeCosts([input], options);
    expect(report.entries.find(entry => entry.role === 'unattributed')!.observedUsageReports![0]!.usage).toEqual([usage]);
    expect(report.completeness).toBe('incomplete');
  });

  it('prices optimizer generations by returned model and keeps observed failures', () => {
    const report = summarizeCosts([], { ...options, optimizerGenerations: [
      { text: 'Candidate', model: 'judge-model', route: 'optimizer-seat', usage },
      { model: 'other-model', route: 'other-seat', usage },
      { model: null, usage: null, outcome: 'generation-error' },
    ] });
    expect(report.entries.map(entry => [entry.role, entry.model, entry.responseRoute])).toEqual([
      ['optimizer', 'judge-model', 'optimizer-seat'], ['optimizer', 'other-model', 'other-seat'], ['optimizer', null, undefined],
    ]);
    expect(report.knownSubtotalUsd.low).toBeCloseTo(0.0051);
    expect(report.apiEquivalentUsd).toBeNull();
    expect(report.entries[2]!.outcome).toBe('generation-error');
  });

  it('never prices a requested optimizer model as though the provider confirmed it', () => {
    const report = summarizeCosts([], { ...options, optimizerGenerations: [
      { model: 'judge-model', modelBasis: 'requested-assumption', usage },
    ] });
    expect(report.apiEquivalentUsd).toBeNull();
    expect(report.entries[0]).toMatchObject({ model: null, requestedModel: 'judge-model', modelBasis: 'unknown', usage });
    expect(report.entries[0]!.valuation.apiEquivalentUsd).toBeNull();
    expect(report.knownSubtotalUsd).toEqual({ low: 0, high: 0 });
  });

  it('preserves cache write counts and passes valuation ranges through', () => {
    const input = trial();
    input.turns[0]!.native.usage = { ...usage, cacheWriteInputTokens: 30 };
    const custom = [{ ...prices[0]!, perMillion: { input: 10, cacheRead: 1, output: 20, cacheWrite5m: 12.5, cacheWrite1h: 20 } }];
    const report = summarizeCosts([input], { ...options, prices: custom });
    expect(report.apiEquivalentUsd).toEqual({ low: 0.001095, high: 0.00132 });
    expect(report.entries[0]!.usage!.cacheWriteInputTokens).toBe(30);
    expect(report.completeness).toBe('complete');
  });

  it('uses the default exact catalog when no override is supplied', () => {
    const report = summarizeCosts([trial()], { subjectModel: 'gpt-5.5' });
    expect(report.apiEquivalentUsd).toEqual({ low: 0.00071, high: 0.00127 });
    expect(report.entries[0]!.valuation.assumptions.some(value => value.includes('context tier'))).toBe(true);
  });

  it.each([null, { ...usage, inputTokens: null }, { ...usage, inputTokens: -1 }, { ...usage, cachedInputTokens: 200 }])(
    'retains missing or invalid usage as incomplete evidence (%j)', badUsage => {
      const input = trial(); input.turns[0]!.native.usage = badUsage;
      const report = summarizeCosts([input], options);
      expect(report.completeness).toBe('incomplete');
      expect(report.apiEquivalentUsd).toBeNull();
      expect(report.entries[0]!.usage).toEqual(badUsage);
      expect(report.warnings.length).toBeGreaterThan(1);
    });

  it('does not replace unknown returned judge models with requested ones', () => {
    const input = trial(); input.evaluation.judgeCalls = [judge('unknown', { responseModel: 'unlisted-model' })];
    const report = summarizeCosts([input], options);
    expect(report.entries[1]!.valuation.status).toBe('unpriced');
    expect(report.knownSubtotalUsd.low).toBeCloseTo(0.00102);
    expect(report.apiEquivalentUsd).toBeNull();
  });

  it('annotates zero-turn failures without inventing a subject call', () => {
    const input = trial(); input.turns = []; input.execution = 'failed'; input.hostWork = 'incomplete';
    const report = summarizeCosts([input], options);
    expect(report.entries).toEqual([]);
    expect(report.completeness).toBe('incomplete');
    expect(report.apiEquivalentUsd).toBeNull();
    expect(report.usageCoverage).toBe('incomplete');
    expect(report.warnings.some(value => value.includes('No subject turn'))).toBe(true);
    expect(report.warnings.some(value => value.includes('settled'))).toBe(true);
  });

  it('does not report an empty preflight or failed preparation as complete zero spend', () => {
    const preflight = summarizeCosts([], options);
    expect(preflight).toMatchObject({ entries: [], completeness: 'incomplete', usageCoverage: 'incomplete',
      apiEquivalentUsd: null, knownSubtotalUsd: { low: 0, high: 0 } });
    const input = trial(); input.turns = []; input.execution = 'failed';
    const report = summarizeCosts([input], options);
    expect(report.entries).toEqual([]);
    expect(report.apiEquivalentUsd).toBeNull();
  });

  it.each(['throw', 'failed-return'] as const)('values observed usage once after a native %s while retaining incomplete totals', outcome => {
    const input = trial(); input.execution = 'failed';
    if (outcome === 'throw') input.turns = [];
    else { input.turns[0]!.native.usage = null; input.turns[0]!.native.status = 'failed'; }
    const event = usageEvent('terminal-observation');
    input.snapshot.events = [event, structuredClone(event)];
    const report = summarizeCosts([input, structuredClone(input)], options);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({ role: 'subject', usage,
      outcome: outcome === 'throw' ? 'unreturned' : 'failed', observedUsageReports: [{ usage: [usage] }] });
    expect(report.knownSubtotalUsd).toEqual({ low: 0.00102, high: 0.00102 });
    expect(report.apiEquivalentUsd).toBeNull(); expect(report.completeness).toBe('incomplete');
  });

  it.each(['cumulative', 'identical-counts', 'conflicting-id'] as const)('does not sum ambiguous usage reports (%s)', scenario => {
    const input = trial(); input.turns = []; input.execution = 'failed';
    const second = scenario === 'identical-counts' ? usage : { ...usage, inputTokens: 200 };
    input.snapshot.events = [usageEvent('first'), usageEvent(scenario === 'conflicting-id' ? 'first' : 'second', second)];
    const report = summarizeCosts([input], options);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]!.usage).toBeNull();
    expect(report.entries[0]!.observedUsageReports!.flatMap(row => row.usage)).toEqual([usage, second]);
    expect(report.knownSubtotalUsd).toEqual({ low: 0, high: 0 });
    expect(report.apiEquivalentUsd).toBeNull();
  });

  it('prefers a returned native total over cumulative observations and retains another unreturned wake separately', () => {
    const input = trial();
    input.snapshot.events = [usageEvent('partial', { ...usage, inputTokens: 50 }), usageEvent('total'),
      usageEvent('unreturned', usage, 'second-wake')];
    const report = summarizeCosts([input], options);
    expect(report.entries.map(entry => entry.usage)).toEqual([usage, usage]);
    expect(report.entries[0]!.observedUsageReports).toHaveLength(2);
    expect(report.knownSubtotalUsd.low).toBeCloseTo(0.00204);
    expect(report.apiEquivalentUsd).toBeNull();
  });

  it('retains an observation with missing token counts as unknown', () => {
    const input = trial(); input.turns = []; input.snapshot.events = [{ ...usageEvent('missing'), usage: undefined }];
    const report = summarizeCosts([input], options);
    expect(report.entries[0]!.usage).toBeNull();
    expect(report.entries[0]!.observedUsageReports).toEqual([{ location: 'snapshot.events["missing"]', usage: [] }]);
    expect(report.apiEquivalentUsd).toBeNull();
  });

  it.each(['missing-snapshot', 'partial-turn', 'absent-turn', 'conflicting-snapshot'])(
    'does not equate priced observations with complete usage coverage (%s)', scenario => {
      const input = trial();
      if (scenario === 'missing-snapshot') input.snapshot.coverage = [];
      else if (scenario === 'conflicting-snapshot') input.snapshot.coverage = [...input.snapshot.coverage,
        { channel: 'usage', completeness: 'partial', ordering: 'source' }];
      else input.turns[0]!.native.coverage = [{ channel: 'usage',
        completeness: scenario === 'partial-turn' ? 'partial' : 'absent', ordering: 'none' }];
      const report = summarizeCosts([input], options);
      expect(report.completeness).toBe('incomplete');
      expect(report.usageCoverage).toBe('incomplete');
      expect(report.apiEquivalentUsd).toBeNull();
      expect(report.knownSubtotalUsd).toEqual({ low: 0.00102, high: 0.00102 });
      expect(report.warnings.some(value => value.includes('recorded amounts may be partial'))).toBe(true);
    });

  it('marks conflicting representations of one call unknown rather than selecting a cost', () => {
    const input = trial();
    input.evaluation.judgeCalls = [judge('same')];
    input.live = [{ checkId: 'prose', boundary: 'event', result: check([judge('same', { usage: { ...usage, inputTokens: 500 } })]) }];
    const report = summarizeCosts([input], options);
    expect(report.entries.filter(entry => entry.role === 'judge')).toHaveLength(1);
    expect(report.entries[1]!.judgeCallVersions).toHaveLength(2);
    expect(report.entries[1]!.valuation.apiEquivalentUsd).toBeNull();
    expect(report.warnings.some(value => value.includes('Conflicting'))).toBe(true);
  });

  it('distinguishes separate real calls with identical counts and judges across trials', () => {
    const first = trial('one'), second = trial('two');
    first.evaluation.judgeCalls = [judge('a')]; second.evaluation.judgeCalls = [judge('b')];
    const report = summarizeCosts([first, second], options);
    expect(report.entries).toHaveLength(4);
    expect(report.groups.find(group => group.role === 'judge')!.entryCount).toBe(2);
    expect(report.apiEquivalentUsd!.low).toBeCloseTo(0.00612);
  });
  it.each([{ citationRepairs: 1 as const }, { repairOf: 'first-call' }])(
    'retains conflicting repair provenance for one judge call as unknown: %j', changed => {
      const input = trial();
      input.evaluation.judgeCalls = [judge('same', { citationRepairs: 0 })];
      input.live = [{ checkId: 'prose', boundary: 'event', result: check([judge('same', changed)]) }];
      const report = summarizeCosts([input], options);
      expect(report.entries.filter(entry => entry.role === 'judge')).toHaveLength(1);
      expect(report.entries[1]!.judgeCallVersions).toHaveLength(2);
      expect(report.entries[1]!.valuation.apiEquivalentUsd).toBeNull();
      expect(report.completeness).toBe('incomplete');
    });
  it('counts a distinct repair once and treats absent legacy policy as its default zero', () => {
    const input = trial();
    input.evaluation.judgeCalls = [judge('legacy'), judge('first', { citationRepairs: 1 }),
      judge('repair', { citationRepairs: 1, repairOf: 'first' })];
    input.live = [{ checkId: 'prose', boundary: 'event', result: check([judge('legacy', { citationRepairs: 0 }),
      judge('repair', { citationRepairs: 1, repairOf: 'first' })]) }];
    const report = summarizeCosts([input], options);
    expect(report.entries.filter(entry => entry.role === 'judge')).toHaveLength(3);
    expect(report.entries.every(entry => entry.judgeCallVersions === undefined)).toBe(true);
    expect(report.apiEquivalentUsd!.low).toBeCloseTo(0.00714);
  });
});
