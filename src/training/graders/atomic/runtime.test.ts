import { expect, it, vi } from 'vitest';
import { parseCheckTemplates, parseDecomposition } from '../decomposition/index.js';
import { parseAtomicGrader } from './format.js';
import { gradeAtomic } from './runtime.js';
import { aggregateAtomic } from './aggregate.js';
import { atomicFeedback } from './feedback.js';
import { createAtomicGradeResultSchema } from './schema.js';
import { z } from 'zod';
import type { AtomicRuntime } from './types.js';
import type { DecisionResult } from '../../contracts/grading.js';
import type { JudgeCall } from '../../contracts/evaluation.js';

function fixture() {
  const grader = parseAtomicGrader({ schema: 'paideia.atomic-grader.v1', id: 'quality', templates: 'templates.yaml',
    extractor: { provider: 'codex', model: 'test' }, decision: { backend: 'typesafe', model: 'jev-1.0.0', max_spend_usd: 1 }, missing: 'unknown',
    aggregation: { method: 'gates-times-coverage-times-quality', critical_pass_at: 0.8, pass_at: 0.5, obligation_kinds: ['obligation'],
      dimensions: { facts: { weight: 1, budget: 2 }, coverage: { weight: 1, budget: 1 } }, penalties: { critical: 1, major: 0.5, minor: 0.1 } } });
  const template = { id: 'support', applies_to: 'claim', type: 'noul', instructions: 'Check {unit.text}', criteria: { true: 'Good', false: 'Bad' },
    expected: [true], state: ['unit'], dimension: 'facts', severity: 'critical' };
  const templates = parseCheckTemplates({ schema: 'paideia.check-templates.v1', templates: [template,
    { ...template, id: 'covered', applies_to: 'obligation', severity: 'major', dimension: 'coverage' }], context: { assignment: { role: 'assignment' } } });
  const inputs = { output: { body: ['Alice was promoted.', 'Bob joined.'] }, context: { assignment: 'Cover Alice.' } };
  const extractor = { provider: 'codex', model: 'test', prompt_digest: 'a'.repeat(64), at: '2026-10-14T00:00:00Z' };
  const doc = parseDecomposition({ schema: 'paideia.decomposition.v1', output: { from: 'trial', sha256: 'b'.repeat(64) },
    units: [{ id: 'c', kind: 'claim', text: 'Alice was promoted.' }, { id: 'o', kind: 'obligation', text: 'Cover Alice.' }],
    extractors: [extractor], audit: { extractor, missed: [], at: extractor.at } });
  const backend = { identity: vi.fn(async () => ({ backend: 'typesafe', model: 'jev-1.0.0' })),
    score: vi.fn<AtomicRuntime['backend']['score']>(async requests => requests.map(request => ({ key: request.key, status: 'ok', probabilities: { true: 0.9, false: 0.1 } }))) } as AtomicRuntime['backend'];
  const runtime: AtomicRuntime = { kind: 'atomic', grader, templates, backend, definitionDigest: 'a'.repeat(64), templatesDigest: 'b'.repeat(64),
    resource: {}, extract: vi.fn(async () => ({ decomposition: doc, receipts: [{ phase: 'extract' }, { phase: 'audit' }], judgeCalls: [] })) };
  return { runtime, inputs, doc, backend };
}

it('scores audited units, binds input identities and preserves typed Noul/Choice/Score requests', async () => {
  const f = fixture();
  const grade = await gradeAtomic(f.runtime, f.inputs);
  expect(grade).toMatchObject({ status: 'pass', coverage: 1, criticalGate: 1, obligationCoverage: 0.9, extraction: { receipts: [{ phase: 'extract' }, { phase: 'audit' }] } });
  expect(grade.score).toBeCloseTo(0.855);
  expect(vi.mocked(f.backend.score).mock.calls[0]![0][0]).toMatchObject({ type: 'noul', expectedOptions: ['true'], optionLabels: ['true', 'false'] });
  const schema = createAtomicGradeResultSchema(z.custom<JudgeCall>());
  expect(schema.parse(grade)).toEqual(grade);
  expect(schema.safeParse({ ...grade, score: 2 }).success).toBe(false);
  f.inputs.output.body[0] = 'Changed output';
  const changed = await gradeAtomic(f.runtime, f.inputs);
  expect(changed.identity.outputDigest).not.toBe(grade.identity.outputDigest);
  expect(changed.coverage).toBeLessThan(1);
  f.inputs.context.assignment = 'Changed assignment';
  expect((await gradeAtomic(f.runtime, f.inputs)).identity.contextDigest).not.toBe(grade.identity.contextDigest);
  f.runtime.templates.templates[0]!.type = 'choice';
  f.runtime.templates.templates[1]!.type = 'score';
  await gradeAtomic(f.runtime, { ...f.inputs, output: { body: ['Alice was promoted.'] }, context: { assignment: 'Cover Alice.' } });
  expect(vi.mocked(f.backend.score).mock.calls.at(-1)![0].map(request => request.type)).toEqual(['choice', 'score']);
});

it('fails critical checks, never dilutes penalties with easy facts and deduplicates correlated occurrences', async () => {
  const f = fixture(), grade = await gradeAtomic(f.runtime, f.inputs);
  const failing = grade.checks.map(score => ({ ...score, probability: score.kind === 'claim' ? 0.5 : 1 }));
  expect(aggregateAtomic(f.runtime.grader, failing)).toMatchObject({ score: 0, criticalGate: 0, coverage: 1 });
  const quality = aggregateAtomic(f.runtime.grader, failing).quality;
  const easy = { ...failing[0]!, probability: 1, occurrence: 'new', severity: 'minor' as const };
  expect(aggregateAtomic(f.runtime.grader, [...failing, ...Array.from({ length: 100 }, () => easy)]).quality).toBe(quality);
  expect(aggregateAtomic(f.runtime.grader, [...failing, failing[0]!]).quality).toBe(quality);
  const bad = { ...failing[0]!, probability: 0, severity: 'major' as const };
  expect(aggregateAtomic(f.runtime.grader, [...failing, bad]).quality).toBe(quality);
  expect(aggregateAtomic(f.runtime.grader, []).score).toBe(0);
  f.runtime.grader.aggregation.dimensions.unused = { budget: 1, weight: 1 };
  expect(aggregateAtomic(f.runtime.grader, failing).quality).toBeGreaterThan(quality);
});

it('keeps missing/rejected/empty and ungraded families in the denominator under both policies', async () => {
  const f = fixture();
  f.doc.units = [];
  let grade = await gradeAtomic(f.runtime, f.inputs);
  expect(grade).toMatchObject({ status: 'unknown', score: 0, coverage: 0, obligationCoverage: 0 });
  expect(grade.checks).toHaveLength(2); expect(f.backend.score).not.toHaveBeenCalled();
  f.runtime.grader.missing = 'fail';
  expect((await gradeAtomic(f.runtime, f.inputs)).status).toBe('fail');
  f.doc.units = [{ id: 'bad', kind: 'claim', text: 'Invented span' }];
  grade = await gradeAtomic(f.runtime, f.inputs);
  expect(grade.coverage).toBe(0); expect(grade.feedback.failed_checks[0]).toMatchObject({ template: 'support', unit: 'Invented span', probability: null });
  f.doc.units = [];
  f.doc.rejected = [{ id: 'bad', unit: { id: 'bad', kind: 'claim', text: 'Invented span' }, reasons: ['Rejected'] }];
  expect((await gradeAtomic(f.runtime, f.inputs)).checks.some(score => score.check.template_id === 'rejected')).toBe(true);
  f.doc.audit!.missed = [{ id: 'o', kind: 'obligation', text: 'Cover Alice.' }];
  expect((await gradeAtomic(f.runtime, f.inputs)).obligationCoverage).toBe(0.9);
});

it.each(['fail', 'unknown'] as const)('excludes verified false conditions and locations under missing: %s', async missing => {
  const f = fixture();
  f.runtime.grader.missing = missing;
  f.doc.units[0]!.fields = { actor: 'Alice' };
  const support = f.runtime.templates.templates[0]!;
  f.runtime.templates.templates.push({ ...support, id: 'bob-only', when: { field: 'actor', equals: 'Bob' } },
    { ...support, id: 'headline-only', locations: ['headline'] });
  vi.mocked(f.backend.score).mockImplementation(async requests => requests.map(request =>
    ({ key: request.key, status: 'ok', probabilities: { true: 1, false: 0 } })));
  const grade = await gradeAtomic(f.runtime, f.inputs);
  expect(grade).toMatchObject({ status: 'pass', score: 1, coverage: 1 });
  expect(grade.checks.map(score => score.check.id)).toEqual(['support@c', 'covered@o']);
  expect(grade.feedback.failed_check_count).toBe(0);
  delete f.doc.units[0]!.fields;
  expect(await gradeAtomic(f.runtime, f.inputs)).toMatchObject({ status: missing, coverage: 2 / 3 });
  f.doc.units[0]!.fields = { actor: 'Alice' };
  f.doc.units[0]!.text = 'Invented Alice span';
  expect((await gradeAtomic(f.runtime, f.inputs)).checks.find(score => score.check.id === 'bob-only@c')?.check.status).toBe('missing');
  f.doc.units = f.doc.units.filter(unit => unit.kind !== 'claim');
  expect((await gradeAtomic(f.runtime, f.inputs)).checks.find(score => score.check.id === 'bob-only@missing')?.check.status).toBe('missing');
});

it('binds declared obligation kinds before extraction and scoring without granting other kinds assignment access', async () => {
  const f = fixture();
  f.runtime.grader.aggregation.obligation_kinds = ['requirement'];
  f.runtime.templates.templates[1]!.applies_to = 'requirement';
  f.doc.units[1]!.kind = 'requirement';
  const grade = await gradeAtomic(f.runtime, f.inputs);
  expect(grade).toMatchObject({ status: 'pass', coverage: 1, obligationCoverage: 0.9 });
  expect(f.runtime.extract).toHaveBeenCalledWith({ ...f.inputs, obligationKinds: ['requirement'] }, undefined);
  expect(grade.checks[1]!.check.projection.unit).toMatchObject({ location: 'context.assignment' });
  f.doc.units[0]!.text = 'Cover Alice.';
  expect((await gradeAtomic(f.runtime, f.inputs)).checks[0]!.check.status).toBe('missing');
});

it('refuses missing audit and backend drift, retains failure receipts and rejects malformed distributions', async () => {
  const f = fixture();
  vi.mocked(f.backend.identity).mockResolvedValue({ backend: 'wrong', model: 'wrong' });
  expect((await gradeAtomic(f.runtime, f.inputs)).status).toBe('error'); expect(f.runtime.extract).not.toHaveBeenCalled();
  vi.mocked(f.backend.identity).mockResolvedValue({ backend: 'typesafe', model: 'jev-1.0.0' });
  const { audit: _audit, ...unaudited } = f.doc;
  vi.mocked(f.runtime.extract).mockResolvedValueOnce({ decomposition: unaudited, receipts: [], judgeCalls: [] });
  expect((await gradeAtomic(f.runtime, f.inputs)).status).toBe('error');
  vi.mocked(f.runtime.extract).mockResolvedValueOnce({ receipts: [{ failure: 'failed' }], judgeCalls: [], error: 'Failed' });
  expect((await gradeAtomic(f.runtime, f.inputs)).extraction.receipts).toEqual([{ failure: 'failed' }]);
  vi.mocked(f.backend.score).mockImplementation(async (_requests, _signal, receipts) => {
    receipts!.push({ billing: 'api', model: 'jev-1.0.0', endpoint: 'https://api.typesafe.ai', inputTokens: null, outputTokens: null,
      usd: null, estimatedInputTokens: 100, estimatedUsd: 0.1, latencyMs: 1, status: 402 });
    throw new Error('Failed');
  });
  expect((await gradeAtomic(f.runtime, f.inputs)).receipts[0]!.status).toBe(402);
  for (const result of [undefined, { key: 'wrong', status: 'ok', probabilities: { true: 1, false: 0 } },
    { status: 'missing', probabilities: null }, { status: 'ok', probabilities: null },
    { status: 'ok', probabilities: { true: 0.5 } }, { status: 'ok', probabilities: { true: NaN, false: 0 } },
    { status: 'ok', probabilities: { true: -1, false: 2 } }, { status: 'ok', probabilities: { true: 0.4, false: 0.4 } },
  ]) {
    vi.mocked(f.backend.score).mockImplementation(async requests => result ? requests.map(request => ({ key: request.key, ...result })) as DecisionResult[] : []);
    expect((await gradeAtomic(f.runtime, f.inputs)).coverage).toBe(0);
  }
  vi.mocked(f.backend.score).mockImplementation(async requests => [...requests, ...requests].map(request => ({ key: request.key, status: 'ok', probabilities: { true: 1, false: 0 } })));
  expect((await gradeAtomic(f.runtime, f.inputs)).coverage).toBe(0);
  await expect(gradeAtomic(f.runtime, f.inputs, AbortSignal.abort())).rejects.toThrow();
});

it('bounds failed-check feedback by count, unit characters and UTF-8 bytes, retaining missing probabilities', async () => {
  const f = fixture(), grade = await gradeAtomic(f.runtime, f.inputs);
  const failed = Array.from({ length: 100 }, () => ({ ...grade.checks[0]!, probability: null, unit: '界'.repeat(10_000) }));
  const policy = { ...f.runtime.grader.feedback, max_checks: 3, max_unit_chars: 50, max_bytes: 512 };
  const feedback = atomicFeedback(failed, policy);
  expect(feedback.failed_checks.length).toBeGreaterThan(0);
  expect(feedback.failed_checks.length).toBeLessThanOrEqual(3);
  expect(feedback.failed_checks[0]!.unit.length).toBe(50);
  expect(Buffer.byteLength(JSON.stringify(feedback))).toBeLessThanOrEqual(512);
  expect(feedback.omitted_failed_checks).toBe(100 - feedback.failed_checks.length);
  expect(atomicFeedback(failed, { ...policy, max_bytes: 10_000 }).failed_checks).toHaveLength(3);
  expect(atomicFeedback(grade.checks, policy).failed_check_count).toBe(0);
});

it('a zero pass threshold cannot override a failing critical gate', async () => {
  const f = fixture(); f.runtime.grader.aggregation.pass_at = 0;
  vi.mocked(f.backend.score).mockImplementation(async requests => requests.map(request => ({ key: request.key, status: 'ok', probabilities: { true: 0.5, false: 0.5 } })));
  expect(await gradeAtomic(f.runtime, f.inputs)).toMatchObject({ status: 'fail', criticalGate: 0, score: 0, coverage: 1 });
});

it.each(['fail', 'unknown'] as const)('keeps partial spend-cap exhaustion unscorable under missing: %s', async missing => {
  const f = fixture(); f.runtime.grader.missing = missing;
  vi.mocked(f.backend.score).mockImplementation(async requests => requests.map((request, index) => index === 0
    ? { key: request.key, status: 'ok', probabilities: { true: 1, false: 0 } }
    : { key: request.key, status: 'missing', probabilities: null, reason: 'spend cap', failureCause: 'spend-cap' }));
  const grade = await gradeAtomic(f.runtime, f.inputs);
  expect(grade).toMatchObject({ status: 'error', score: null, coverage: 0.5, failure: { cause: 'spend-cap', reason: 'spend cap' } });
  expect(grade.checks[1]!.decision).toMatchObject({ status: 'missing', reason: 'spend cap', failureCause: 'spend-cap' });
  const schema = createAtomicGradeResultSchema(z.custom<JudgeCall>());
  expect(schema.parse(JSON.parse(JSON.stringify(grade)))).toEqual(grade);
  expect(schema.safeParse({ ...grade, failure: { cause: 'invented', reason: 'spend cap' } }).success).toBe(false);
  expect(schema.safeParse({ ...grade, status: 'fail' }).success).toBe(false);
  expect(schema.safeParse({ ...grade, score: 0 }).success).toBe(false);
  expect(schema.safeParse({ ...grade, failure: undefined }).success).toBe(false);
  expect(schema.safeParse({ ...grade, failure: undefined, status: 'fail', score: 0 }).success).toBe(false);
  // Ordinary missing content with the same prose must keep the authored policy: no string-based classification.
  vi.mocked(f.backend.score).mockImplementation(async requests => requests.map(request =>
    ({ key: request.key, status: 'missing', probabilities: null, reason: 'spend cap' })));
  expect(await gradeAtomic(f.runtime, f.inputs)).toMatchObject({ status: missing, score: 0 });
});
