import { expect, it } from 'vitest';
import type { SubjectUsageSnapshot } from '../../contracts/evaluation.js';
import { createEvaluationRegistry, evaluateNode, result } from '../../evaluation/index.js';
import { subjectUsageSnapshot } from '../trials/index.js';
import { fixture } from './fixture.js';
import { capturedTrial } from './source.js';
import { trialReportSchema } from './schema.js';
import { rescoreStoredTrial } from './rescore.js';
import { evaluationContext, snapshot } from '../../testing/index.js';

async function captured() {
  return fixture(report => {
    report.expectedTurns = 1;
    report.turns[0]!.native.coverage.push({ channel: 'usage', completeness: 'complete', ordering: 'source' });
    report.stop!.quiescence = 'confirmed';
    report.snapshot.subjectUsage = subjectUsageSnapshot(report.turns.map(row => row.native), { complete: true, expectedTurns: 1 });
  });
}

it('authenticates preserved subject totals and reuses them in explicit rescoring without subject cognition', async () => {
  const task = await captured();
  const seen: SubjectUsageSnapshot[] = [];
  task.options.registry = createEvaluationRegistry({ inspect: { definition: { version: '1', kind: 'mechanical', incremental: true, stopProof: false, validate() {} },
    async evaluate(_check, context) { seen.push(structuredClone(context.snapshot.subjectUsage!)); return result('pass', 'captured usage'); } } });
  task.options.dataset.records[0]!.effectiveStages = [{ id: 'usage', checks: [{ id: 'observed', eval: 'inspect' }] }];
  expect((await rescoreStoredTrial(task.options)).status).toBe('pass');
  expect(seen).toEqual([task.report.snapshot.subjectUsage]);
  const replay = await task.store.readReplay('trial', task.options.access);
  expect(capturedTrial(replay).report.snapshot.subjectUsage).toEqual(task.report.snapshot.subjectUsage);
  expect(task.report.snapshot.subjectUsage).toEqual({ status: 'complete', settled: true, usage: { inputTokens: 10, cachedInputTokens: null, outputTokens: 2, reasoningTokens: null, source: 'fixture' } });
});

it('legacy captures remain readable but never acquire invented usage evidence', async () => {
  const task = await fixture();
  const replay = await task.store.readReplay('trial', task.options.access);
  expect(capturedTrial(replay).report.snapshot.subjectUsage).toBeUndefined();
});

it('rejects malformed counters, unsupported status and totals that differ from native returned receipts', async () => {
  const { report } = await captured();
  expect(trialReportSchema.parse(report)).toEqual(report);
  for (const patch of [{ status: 'invented' }, { usage: null }, { usage: { ...report.turns[0]!.native.usage, inputTokens: -1 } },
    { usage: { ...report.turns[0]!.native.usage, inputTokens: Number.MAX_SAFE_INTEGER + 1 } },
    { usage: { ...report.turns[0]!.native.usage, inputTokens: 1.5 } },
    { usage: { ...report.turns[0]!.native.usage, inputTokens: Infinity } },
    { usage: { ...report.turns[0]!.native.usage, outputTokens: 1 } }]) {
    expect(() => trialReportSchema.parse({ ...report, snapshot: { ...report.snapshot, subjectUsage: { ...report.snapshot.subjectUsage, ...patch } } })).toThrow();
  }
  for (const patch of [{ turns: [] }, { stop: { ...report.stop, quiescence: 'unknown' } }]) {
    expect(() => trialReportSchema.parse({ ...report, ...patch })).toThrow('Subject usage');
  }
});

it('preserves incomplete source measurements without promoting them during replay', async () => {
  const { report } = await fixture(report => {
    report.expectedTurns = 1;
    report.snapshot.subjectUsage = subjectUsageSnapshot(report.turns.map(row => row.native), { complete: false, expectedTurns: 1 });
  });
  expect(trialReportSchema.parse(report).snapshot.subjectUsage).toEqual(report.snapshot.subjectUsage);
});


it('later evaluator failure cannot erase a host-attested successful native measurement', async () => {
  const { report } = await captured();
  for (const patch of [{ execution: 'failed' as const }, { hostWork: 'incomplete' as const }]) {
    expect(trialReportSchema.parse({ ...report, ...patch }).snapshot.subjectUsage).toEqual(report.snapshot.subjectUsage);
  }
});


it('rejects a complete claim with truncated planned work before any replay evaluation', async () => {
  const task = await captured();
  for (const expectedTurns of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 2]) {
    expect(() => trialReportSchema.parse({ ...task.report, expectedTurns })).toThrow();
  }
  const truncated = await fixture(report => {
    report.expectedTurns = 2;
    report.turns[0]!.native.coverage.push({ channel: 'usage', completeness: 'complete', ordering: 'source' });
    report.stop!.quiescence = 'confirmed';
    report.snapshot.subjectUsage = subjectUsageSnapshot(report.turns.map(row => row.native), { complete: true, expectedTurns: 1 });
  });
  await expect(rescoreStoredTrial(truncated.options)).rejects.toThrow('Subject usage');
});

it('a legacy complete capture without settlement still parses and never certifies an absent artifact', async () => {
  const { report } = await captured();
  const { settled: _settled, ...legacy } = report.snapshot.subjectUsage!;
  const stored = { ...report, snapshot: { ...report.snapshot, subjectUsage: legacy } };
  expect(trialReportSchema.parse(stored).snapshot.subjectUsage).toEqual(legacy);
  const check = { eval: 'contains-any', input: 'artifact:none#/body', values: ['Filed'] };
  const context = evaluationContext({ snapshot: snapshot({ subjectUsage: legacy }) });
  expect((await evaluateNode(check, context, createEvaluationRegistry())).status).toBe('unknown');
  // A capture that does attest settlement is authenticated against it, and a forged one is refused.
  expect(() => trialReportSchema.parse({ ...stored, snapshot: { ...stored.snapshot, subjectUsage: { ...legacy, settled: false } } })).toThrow('Subject usage');
});
