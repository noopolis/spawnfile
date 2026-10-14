import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { stringify as yamlStringify } from 'yaml';
import type { InferenceProvider } from '../../../contracts/execution.js';
import type { AtomicRuntime } from '../../../graders/atomic/index.js';
import { gradeAtomic } from '../../../graders/atomic/index.js';
import { evaluatePlan, createEvaluationRegistry } from '../../../evaluation/index.js';
import { evaluationContext, artifact, snapshot } from '../../../testing/index.js';
import { CliDatasets } from '../../datasets.js';
import * as teacherFactory from '../label-call.js';
import { buildAtomicRuntime } from './runtime.js';
import { buildExecutableGradingRuntime } from '../runtime.js';

const stringify = (value: unknown) => yamlStringify(value, { aliasDuplicateObjects: false });
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  vi.stubEnv('TYPESAFE_API_KEY', 'synthetic-offline-key');
  const root = await mkdtemp(join(tmpdir(), 'atomic-host-')); roots.push(root);
  const grader = { schema: 'paideia.atomic-grader.v1', id: 'quality', templates: 'templates.yaml',
    extractor: { provider: 'codex', model: 'test-codex' }, decision: { backend: 'typesafe', model: 'jev-1.0.0', max_spend_usd: 1 }, missing: 'unknown',
    aggregation: { method: 'gates-times-coverage-times-quality', critical_pass_at: 0.8, pass_at: 0.1, obligation_kinds: ['obligation'],
      dimensions: { quality: { weight: 1, budget: 2 } }, penalties: { critical: 1, major: 0.5, minor: 0.1 } } };
  const template = { id: 'support', applies_to: 'claim', type: 'noul', instructions: 'Does {unit.text} hold?', criteria: { true: 'Supported', false: 'Unsupported' },
    expected: [true], state: ['unit', 'unit.cited_rows'], dimension: 'quality', severity: 'critical' };
  const templates = { schema: 'paideia.check-templates.v1', templates: [template,
    { ...template, id: 'covered', applies_to: 'obligation', state: ['unit', 'output.body'], severity: 'major' },
    { ...template, id: 'relation', applies_to: 'relation', state: ['unit', 'unit.pair.cited_rows'], severity: 'minor' }],
    context: { assignment: { role: 'assignment' }, evidence: { rows: { heading: '^## (R[0-9]+)$', cite: '\\[(R[0-9]+)\\]' } } } };
  const inputs = { output: { body: ['Alice joined. [R1]', 'Bob joined. [R2]'] }, context: {
    assignment: 'Cover the team.', evidence: '## R1\nAlice joined.\n## R2\nBob joined.\n' } };
  const units = [{ id: 'claim', kind: 'claim', text: 'Alice joined.' }, { id: 'obligation', kind: 'obligation', text: 'Cover the team.' },
    { id: 'pair', kind: 'relation', text: 'Alice joined.', pair: { left: { text: 'Alice joined.' }, right: { text: 'Bob joined.' } } }];
  const generate = vi.fn<InferenceProvider['generate']>(async request => ({ model: request.model, route: 'subscription', usage: null,
    text: JSON.stringify({ units: JSON.parse(request.prompt).task.startsWith('Independently') ? [] : units }) }));
  const provider: InferenceProvider = { id: 'fake', capabilities: { billing: 'subscription', tools: 'contained', temperature: false, seed: false }, generate };
  const atomicFetch = vi.fn<typeof fetch>(async (_url, init) => {
    const payload = JSON.parse(init!.body as string);
    return Response.json({ model: payload.model, usage: { input_tokens: 100, output_tokens: 0 },
      answers: Object.fromEntries(Object.entries(payload.questions).map(([key, value]) => [key, (value as { type: string }).type === 'noul'
        ? { type: 'noul', noul: 0.9 } : { type: 'choice', probabilities: { yes: 0.9, no: 0.1 } }])) });
  });
  const file = join(root, 'grader.yaml');
  await writeFile(file, stringify(grader)); await writeFile(join(root, 'templates.yaml'), stringify(templates));
  const check = { id: 'quality', eval: 'grader', grader: 'grader.yaml', input: 'artifact:article',
    context: { assignment: 'artifact:assignment', evidence: 'artifact:evidence' } };
  const dataset = { schema: 'paideia.dataset.v1', id: 'train', checks: [check],
    records: [{ id: 'one', group: 'lineage', input: { prompt: 'Write' }, outputs: { article: 'out.json' } }] };
  await writeFile(join(root, 'dataset.yaml'), stringify(dataset));
  return { root, grader, templates, inputs, generate, provider, atomicFetch, file, check, dataset,
    dependencies: { provider: () => provider, atomicFetch } };
}

it('executes protected grader files through CLI dataset routes and trial evaluation with real pair projections and receipts', async () => {
  const f = await fixture(), loader = new CliDatasets({}, f.root);
  const dataset = loader.load('dataset.yaml', true);
  const routes = await loader.buildGraders(f.dependencies, true);
  const runtime = routes[f.file] as AtomicRuntime;
  expect(runtime.grader.extractor.deadline_ms).toBe(900_000);
  const artifacts = { article: artifact(f.inputs.output),
    assignment: { ...artifact(f.inputs.context.assignment), name: 'assignment' }, evidence: { ...artifact(f.inputs.context.evidence), name: 'evidence' } };
  const context = evaluationContext({ graders: routes, snapshot: snapshot({ artifacts }) });
  const result = await evaluatePlan(dataset.sharedStages, context, createEvaluationRegistry());
  expect(result.status, JSON.stringify({ reason: result.checks.quality?.reason, scores: result.checks.quality?.atomicGrading?.checks.map(s => [s.kind, s.probability, s.check.reasons]) })).toBe('pass');
  const grade = result.checks.quality!.atomicGrading!;
  expect(grade).toMatchObject({ coverage: 1, criticalGate: 1, obligationCoverage: 0.9, identity: { definitionDigest: runtime.definitionDigest, templatesDigest: runtime.templatesDigest } });
  expect(grade.extraction.receipts).toHaveLength(1);
  expect(grade.judgeCalls).toHaveLength(2);
  expect(grade.receipts).toHaveLength(3);
  expect(f.generate).toHaveBeenCalledTimes(2);
  expect(f.generate.mock.calls[1]![0].prompt).toContain('Independently audit omissions');
  const sent = f.atomicFetch.mock.calls.map(([, init]) => JSON.parse(init!.body as string));
  expect(sent.find(payload => payload.state.includes('unit.pair.cited_rows')).state).toContain('Bob joined');
  expect(JSON.stringify(grade)).not.toContain('synthetic-offline-key');
  expect((await readdir(tmpdir())).filter(name => name.startsWith('paideia-atomic-trial-'))).toEqual([]);
  await writeFile(join(f.root, 'templates.yaml'), stringify({ ...f.templates, kinds: { claim: 'Changed' } }));
  await expect(loader.buildGraders(f.dependencies)).rejects.toThrow('changed after dataset resolution');
});

it('loads authoring once, shares endpoint resources, rejects missing auth before extraction and obeys zero spend', async () => {
  const f = await fixture();
  const runtime = await buildExecutableGradingRuntime(f.file, f.dependencies) as AtomicRuntime;
  expect(runtime.resources).toEqual((await buildAtomicRuntime(f.file, f.dependencies)).resources);
  await writeFile(join(f.root, 'templates.yaml'), 'invalid');
  const graded = await gradeAtomic(runtime, f.inputs);
  expect(graded.status, JSON.stringify(graded.checks.map(s => [s.kind, s.probability, s.check.reasons]))).toBe('pass');
  await writeFile(join(f.root, 'templates.yaml'), stringify(f.templates));
  vi.stubEnv('TYPESAFE_API_KEY', '');
  await expect(buildAtomicRuntime(f.file, f.dependencies)).rejects.toThrow('TYPESAFE_API_KEY');
  vi.stubEnv('TYPESAFE_API_KEY', 'synthetic-offline-key');
  f.atomicFetch.mockClear();
  const capped = await buildAtomicRuntime(f.file, { ...f.dependencies, maxSpendUsd: 0 });
  expect((await gradeAtomic(capped, f.inputs))).toMatchObject({ status: 'error', score: null, coverage: 0,
    failure: { cause: 'spend-cap', reason: 'spend cap' }, receipts: [] });
  expect(f.atomicFetch).not.toHaveBeenCalled();
  await expect(buildExecutableGradingRuntime(f.file, f.dependencies, AbortSignal.abort())).rejects.toThrow();
});

it.each(['extract', 'audit'])('binds custom obligation kinds through the %s phase and trial scoring', async phase => {
  const f = await fixture(), original = f.generate.getMockImplementation()!;
  f.grader.aggregation.obligation_kinds = ['requirement'];
  f.templates.templates[1]!.applies_to = 'requirement';
  await writeFile(f.file, stringify(f.grader));
  await writeFile(join(f.root, 'templates.yaml'), stringify(f.templates));
  f.generate.mockImplementation(async request => {
    const result = await original(request), prompt = JSON.parse(request.prompt);
    expect(prompt.obligation_kinds).toEqual(['requirement']);
    const audit = prompt.task.startsWith('Independently');
    const units = JSON.parse(result.text).units.filter((unit: { kind: string }) => unit.kind !== 'obligation');
    if (audit === (phase === 'audit')) units.push({ id: 'required', kind: 'requirement', text: 'Cover the team.' });
    return { ...result, text: JSON.stringify({ units }) };
  });
  const runtime = await buildAtomicRuntime(f.file, f.dependencies);
  const grade = await gradeAtomic(runtime, f.inputs);
  expect(grade).toMatchObject({ status: 'pass', coverage: 1, obligationCoverage: 0.9 });
  expect(grade.checks.find(score => score.kind === 'requirement')!.check.projection.unit).toMatchObject({ location: 'context.assignment' });
  expect(grade.extraction.decomposition!.rejected).toBeUndefined();
  expect(f.generate).toHaveBeenCalledTimes(2);
});

it('retains failed extraction/audit responses and cancellation receipts without leaking diagnostic errors', async () => {
  const f = await fixture(), runtime = await buildAtomicRuntime(f.file, f.dependencies);
  f.generate.mockResolvedValueOnce({ text: 'malformed', model: 'test-codex', route: 'subscription', usage: null });
  const malformed = await gradeAtomic(runtime, f.inputs);
  expect(malformed.status).toBe('error');
  expect(malformed.extraction.receipts[0]).toMatchObject({ receipts: [{ outcome: 'invalid-response', response_text: 'malformed' }] });
  f.generate.mockRejectedValueOnce(new Error('SECRET DIAGNOSTIC'));
  const failure = await gradeAtomic(runtime, f.inputs);
  expect(failure.extraction.judgeCalls[0]!.outcome).toBe('generation-error');
  expect(JSON.stringify(failure)).not.toContain('SECRET DIAGNOSTIC');
  f.generate.mockImplementationOnce(async request => {
    await new Promise(resolve => request.signal!.addEventListener('abort', resolve, { once: true }));
    request.signal!.throwIfAborted(); throw new Error('unreachable');
  });
  await writeFile(f.file, stringify({ ...f.grader, extractor: { ...f.grader.extractor, deadline_ms: 10 } }));
  const timed = await buildAtomicRuntime(f.file, f.dependencies);
  const cancelled = await gradeAtomic(timed, f.inputs);
  expect(cancelled.extraction.receipts[0]).toMatchObject({ receipts: [{ outcome: 'cancelled' }] });
  expect(f.atomicFetch).not.toHaveBeenCalled();
});

it('enforces malformed file contracts at resolution and changed grader bytes before inference', async () => {
  const f = await fixture();
  const loader = new CliDatasets({}, f.root); loader.load('dataset.yaml', true);
  await writeFile(f.file, stringify({ ...f.grader, missing: 'fail' }));
  await expect(loader.buildGraders(f.dependencies)).rejects.toThrow('changed after dataset resolution');
  for (const change of [{ context: {} }, { context: { unknown: 'input:files' } }]) {
    await writeFile(join(f.root, 'dataset.yaml'), stringify({ ...f.dataset, checks: [{ ...f.check, ...change }] }));
    expect(() => new CliDatasets({}, f.root).load('dataset.yaml', true)).toThrow('grader context');
  }
  expect(f.generate).not.toHaveBeenCalled();
});

it.each(['fail', 'unknown'] as const)('keeps payment failures as errors under missing: %s and stops admission', async missing => {
  const f = await fixture();
  await writeFile(f.file, stringify({ ...f.grader, missing }));
  f.atomicFetch.mockResolvedValue(new Response('synthetic-offline-key', { status: 402 }));
  const loader = new CliDatasets({}, f.root), dataset = loader.load('dataset.yaml', true);
  const routes = await loader.buildGraders(f.dependencies, true);
  const result = await evaluatePlan(dataset.sharedStages, evaluationContext({ graders: routes, snapshot: snapshot({ artifacts: {
    article: artifact(f.inputs.output), assignment: artifact(f.inputs.context.assignment), evidence: artifact(f.inputs.context.evidence),
  } }) }), createEvaluationRegistry());
  expect(result.status).toBe('error');
  expect(result.checks.quality!.atomicGrading).toMatchObject({ status: 'error', receipts: [{ status: 402, usd: null }] });
  expect(f.atomicFetch).toHaveBeenCalledTimes(1);
  expect(f.generate).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(result)).not.toContain('synthetic-offline-key');
});

it.each(['effort', 'score', 'choice'] as const)('rejects incompatible %s authoring during dataset resolution and runtime construction', async control => {
  const f = await fixture();
  if (control === 'effort') await writeFile(f.file, stringify({ ...f.grader, extractor: { ...f.grader.extractor, effort: 'max' } }));
  else {
    const count = control === 'score' ? 11 : 256;
    const covered = f.templates.templates[1]!;
    await writeFile(join(f.root, 'templates.yaml'), stringify({ ...f.templates, templates: [{ ...covered, type: control,
      criteria: Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i), `Anchor ${i}`])), expected: ['0'],
    }] }));
  }
  const error = control === 'effort' ? /effort/ : /TypeSafe/;
  expect(() => new CliDatasets({}, f.root).load('dataset.yaml', true)).toThrow(error);
  await expect(buildAtomicRuntime(f.file, f.dependencies)).rejects.toThrow(error);
  expect(f.generate).not.toHaveBeenCalled();
  expect(f.atomicFetch).not.toHaveBeenCalled();
});

it('uses the subscription Codex provider factory with the declared deadline and keeps pre-extraction failures explicit', async () => {
  const f = await fixture();
  const teacher = vi.spyOn(teacherFactory, 'createGraderTeacher').mockReturnValue(f.provider);
  const runtime = await buildAtomicRuntime(f.file, { atomicFetch: f.atomicFetch });
  expect((await gradeAtomic(runtime, f.inputs, new AbortController().signal)).status).toBe('pass');
  expect(teacher).toHaveBeenCalledWith({ id: 'extractor', provider: 'codex', model: 'test-codex' }, 900_000);
  f.generate.mockClear();
  const invalid = await gradeAtomic(runtime, { ...f.inputs, context: { undeclared: 'Unbound' } });
  expect(invalid.status).toBe('error'); expect(invalid.extraction.receipts).toEqual([]);
  expect(f.generate).not.toHaveBeenCalled();
});

it('retains native inference attempt identities and per-attempt usage without counting aggregate usage twice', async () => {
  const f = await fixture(), original = f.generate.getMockImplementation()!;
  const usage = { inputTokens: 3, cachedInputTokens: null, outputTokens: 1, reasoningTokens: null, source: 'fake-reported' };
  const base = { ordinal: 0, providerId: 'codex-subscription', requestedModel: 'test-codex', responseModel: 'reported-codex',
    responseRoute: 'subscription', startedAt: '2026-10-14T00:00:00Z', completedAt: '2026-10-14T00:00:01Z', usage };
  f.generate.mockImplementationOnce(async request => ({ ...await original(request), usage: { ...usage, inputTokens: 100 },
    attempts: [{ ...base, id: 'failed-attempt', outcome: 'failed', failureKind: 'transport' },
      { ...base, ordinal: 1, id: 'completed-attempt', outcome: 'completed', failureKind: null }] }));
  const runtime = await buildAtomicRuntime(f.file, f.dependencies);
  const graded = await gradeAtomic(runtime, f.inputs);
  expect(graded.status).toBe('pass');
  expect(graded.judgeCalls.slice(0, 2)).toMatchObject([{ id: 'failed-attempt', outcome: 'generation-error', usage },
    { id: 'completed-attempt', outcome: 'completed', usage }]);
  expect(graded.judgeCalls.reduce((sum, call) => sum + (call.usage?.inputTokens ?? 0), 0)).toBe(6);
  f.generate.mockResolvedValueOnce({ model: 'test-codex', route: 'subscription', usage: null, text: 'malformed',
    attempts: [{ ...base, id: 'malformed-attempt', outcome: 'completed', failureKind: null }] });
  expect((await gradeAtomic(runtime, f.inputs)).judgeCalls[0]).toMatchObject({ id: 'malformed-attempt', outcome: 'invalid-response' });
});
