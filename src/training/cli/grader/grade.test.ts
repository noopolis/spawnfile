import { CliDatasets } from '../datasets.js';
import { runValidate } from './validate.js';
import { runCalibrate } from './calibrate.js';
import { createEvaluationRegistry, evaluatePlan } from '../../evaluation/index.js';
import { artifact, evaluationContext, snapshot } from '../../testing/index.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { createCalibrationIdentity, expandInstances, loadGrader, loadLabels, parseGrader } from '../../graders/index.js';
import type { DecisionBackend, DecisionRequest } from '../../contracts/grading.js';
import { DECISION_PROMPT_VERSION } from '../../inference/decision/index.js';
import { main } from '../commands.js';
import { backendIdentity } from './backend.js';
import { runExpand, runGrade } from './grade.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(checkGate = false) {
  const root = await mkdtemp(join(tmpdir(), 'grader-grade-')); roots.push(root);
  const graderFile = join(root, 'grader.yaml'), outputFile = join(root, 'output.json');
  const source = parseGrader({ schema: 'paideia.grader.v1', id: 'report', golden: 'labels.yaml', calibration: 'calibration.json',
    context: { evidence: { description: 'Sources' }, policy: { description: 'Rules' } },
    teachers: [{ id: 'teacher', provider: 'claude', model: 'opus' }],
    model: { backend: 'jev-http', endpoint: 'http://localhost:8080', name: 'decision' },
    escalate: { to: 'teacher', between: [0.4, 0.6], max_calls_per_trial: 1 },
    gates: checkGate ? [{ id: 'accepted', check: { eval: 'equals', input: 'output.text', value: 'accepted' } }] : [],
    questions: [{ id: 'q', type: 'yes-no', expected: 'yes', reads: ['output.body', 'context.evidence', 'context.policy'] }],
    score: { method: 'weighted', pass_at: 0.8 } });
  await writeFile(graderFile, stringify(source));
  await writeFile(join(root, 'labels.yaml'), stringify({ schema: 'paideia.labels.v1', grader: 'report', labelers: {}, labels: [] }));
  await writeFile(outputFile, JSON.stringify({ body: ['Report text.'] }));
  await writeFile(join(root, 'evidence.json'), JSON.stringify({ fact: true }));
  await writeFile(join(root, 'policy.md'), 'Exact rules\n');
  const score = vi.fn(async (requests: DecisionRequest[]) => requests.map(request => ({ key: request.key,
    status: 'ok' as const, probabilities: { yes: 0.99, no: 0.01 } })));
  const backend: DecisionBackend = { identity: async () => ({ backend: 'jev-http', model: 'decision' }), score };
  const grader = await loadGrader(graderFile), golden = await loadLabels(grader.golden, grader);
  const calibration = { schema: 'paideia.grader-calibration.v1', identity: createCalibrationIdentity(grader, {
    backendModel: await backendIdentity(grader, backend), golden: golden.goldenDigest,
    promptTemplateVersion: DECISION_PROMPT_VERSION, seed: '0', exclusions: [] }),
    questions: { q: { status: 'calibrated', failures: [], params: { a: 1, b: 0 }, band: [0.4, 0.6],
      metrics: { groups: 20, instances: 40, good: 20, bad: 20, baseRate: 0.5 } } } };
  await writeFile(grader.calibration, JSON.stringify(calibration));
  const dependencies = { backend: () => backend };
  const contextFiles = { evidence: join(root, 'evidence.json'), policy: join(root, 'policy.md') };
  return { root, graderFile, outputFile, grader, score, backend, dependencies, contextFiles, calibration };
}

it('grades real files with exact JSON/text contexts and prints result JSON', async () => {
  const f = await fixture();
  const result = await runGrade(f, f.dependencies);
  expect(result).toMatchObject({ status: 'pass', score: 0.99, coverage: 1 });
  expect(f.score.mock.calls[0]![0][0]!.projection).toEqual({
    'output.body': ['Report text.'], 'context.evidence': { fact: true }, 'context.policy': 'Exact rules\n',
  });
  const output: string[] = [];
  expect(await main(['grader', 'grade', '--grader', 'grader.yaml', '--output', 'output.json',
    '--context', 'evidence=evidence.json', '--context', 'policy=policy.md'],
  { cwd: f.root, stdout: text => output.push(text), stderr: text => { throw new Error(text); } }, { grader: f.dependencies })).toBe(0);
  expect(JSON.parse(output[0]!)).toMatchObject({ status: 'pass', identity: expect.any(Object), judgeCalls: expect.any(Array) });
});

it('returns unknown for missing contexts or check gates without trial evidence', async () => {
  const f = await fixture();
  expect(await runGrade({ graderFile: f.graderFile, outputFile: f.outputFile }, f.dependencies)).toMatchObject({ status: 'unknown', coverage: 0 });
  expect(f.score).not.toHaveBeenCalled();
  const gated = await fixture(true);
  expect(await runGrade(gated, gated.dependencies)).toMatchObject({ status: 'unknown', gates: [{ id: 'accepted', status: 'unknown' }] });
});

it('uses exit one for failed and incomplete grading', async () => {
  const f = await fixture();
  const output: string[] = [];
  const io = { cwd: f.root, stdout: (text: string) => output.push(text), stderr: (text: string) => { throw new Error(text); } };
  expect(await main(['grader', 'grade', '--grader', 'grader.yaml', '--output', 'output.json'], io, { grader: f.dependencies })).toBe(1);
  expect(JSON.parse(output.pop()!).status).toBe('unknown');
  f.backend.score = async requests => requests.map(request => ({ key: request.key, status: 'ok', probabilities: { yes: 0.01, no: 0.99 } }));
  expect(await main(['grader', 'grade', '--grader', 'grader.yaml', '--output', 'output.json',
    '--context', 'evidence=evidence.json', '--context', 'policy=policy.md'], io, { grader: f.dependencies })).toBe(1);
  expect(JSON.parse(output.pop()!).status).toBe('fail');
});

it('refuses malformed input, unknown contexts, cancellation and calibration drift', async () => {
  const f = await fixture();
  await expect(runGrade({ ...f, contextFiles: { other: f.outputFile } }, f.dependencies)).rejects.toThrow('Unknown grader context other');
  await expect(runGrade({ ...f, signal: AbortSignal.abort() }, f.dependencies)).rejects.toThrow();
  await writeFile(f.contextFiles.evidence, '{broken');
  await expect(runGrade(f, f.dependencies)).rejects.toThrow();
  await writeFile(f.outputFile, '{broken');
  await expect(runGrade(f, f.dependencies)).rejects.toThrow();
  await writeFile(f.outputFile, '{}');
  f.backend.identity = async () => ({ backend: 'jev-http', model: 'changed' });
  const errors: string[] = [];
  expect(await main(['grader', 'grade', '--grader', 'grader.yaml', '--output', 'output.json'],
    { cwd: f.root, stdout: () => undefined, stderr: text => errors.push(text) }, { grader: f.dependencies })).toBe(2);
  expect(errors.join('')).toContain('backendModel');
  expect(await readFile(f.grader.calibration, 'utf8')).toBe(JSON.stringify(f.calibration));
});

it('propagates cancellation through grade identity probes, scoring and teacher calls', async () => {
  const f = await fixture(); const controller = new AbortController();
  const identity = f.backend.identity;
  const probes: AbortSignal[] = [];
  f.backend.identity = async signal => { expect(signal).toBe(controller.signal); probes.push(signal!); return identity(signal); };
  f.backend.score = async (requests, signal) => {
    expect(signal).toBe(controller.signal);
    return requests.map(request => ({ key: request.key, status: 'ok', probabilities: { yes: 0.5, no: 0.5 } }));
  };
  const generate = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
    expect(signal).toBe(controller.signal);
    controller.abort(new Error('teacher deadline')); throw new Error('teacher deadline');
  });
  await expect(runGrade({ ...f, signal: controller.signal }, { ...f.dependencies, provider: () => ({ id: 'claude-subscription',
    capabilities: { billing: 'subscription', tools: 'disabled', seed: false, temperature: false }, generate }) })).rejects.toThrow('teacher deadline');
  expect(probes.length).toBeGreaterThanOrEqual(2);
  expect(generate).toHaveBeenCalledOnce();
});

it('expands exact runtime units and digests without labels, calibration or inference', async () => {
  const f = await fixture();
  const source = parseGrader({ ...f.grader, questions: [
    { id: 'article', type: 'yes-no', expected: 'yes', reads: ['output.body', 'context.policy'] },
    { id: 'paragraph', level: 'paragraph', type: 'yes-no', expected: 'yes', reads: ['paragraph'] },
    { id: 'sentence', level: 'sentence', type: 'yes-no', expected: 'yes', reads: ['sentence', 'context.evidence'] },
    { id: 'missing', type: 'yes-no', expected: 'yes', reads: ['output.absent', 'output.alsoAbsent'] },
    { id: 'inapplicable', type: 'yes-no', expected: 'yes', reads: ['output.body'], when: { field: 'output.enabled', equals: true } },
  ] });
  const output = { body: ['Dr. Lane agreed. Another claim!', 'Final paragraph.'], enabled: false };
  await writeFile(f.graderFile, stringify(source));
  await writeFile(f.outputFile, JSON.stringify(output));
  await rm(f.grader.calibration);
  await rm(join(f.root, 'labels.yaml'));
  const printed: string[] = [];
  const backend = vi.fn(() => { throw new Error('inference is forbidden'); });
  const provider = vi.fn(() => { throw new Error('inference is forbidden'); });
  expect(await main(['grader', 'expand', '--grader', 'grader.yaml', '--output', 'output.json',
    '--context', 'evidence=evidence.json', '--context', 'policy=policy.md'],
  { cwd: f.root, stdout: text => printed.push(text), stderr: text => { throw new Error(text); } },
  { grader: { backend, provider } })).toBe(0);
  const expected = expandInstances(source, output, { evidence: { fact: true }, policy: 'Exact rules\n' });
  const result = JSON.parse(printed[0]!) as Awaited<ReturnType<typeof runExpand>>;
  expect(result.instances).toEqual(expected.map(({ key, questionId, level, unit, state, reasons, projectionDigest }) => ({
    key, questionId, level, unit, state, ...(reasons.length ? { reason: reasons.join('; ') } : {}), projectionDigest,
  })));
  expect(result.instances.filter(instance => instance.level === 'sentence').map(instance => instance.key))
    .toEqual(['sentence@p0.s0', 'sentence@p0.s1', 'sentence@p0.s2', 'sentence@p1.s0']);
  expect(result.instances.find(instance => instance.key === 'article')?.unit).toEqual({});
  expect(result.instances.find(instance => instance.key === 'sentence@p1.s0')?.unit)
    .toEqual({ paragraph: 1, sentence: 0, text: 'Final paragraph.' });
  expect(result.instances.find(instance => instance.key === 'missing')).toMatchObject({ state: 'missing',
    reason: 'output.absent: missing path absent; output.alsoAbsent: missing path alsoAbsent' });
  expect(result.instances.find(instance => instance.key === 'inapplicable')?.state).toBe('not-applicable');
  expect(backend).not.toHaveBeenCalled();
  expect(provider).not.toHaveBeenCalled();
});

it('expands missing contexts and rejects invalid files, unknown contexts and cancellation', async () => {
  const f = await fixture();
  const withoutContexts = await runExpand({ graderFile: f.graderFile, outputFile: f.outputFile });
  expect(withoutContexts.instances[0]).toMatchObject({ state: 'missing', reason: expect.stringContaining('context.evidence') });
  await expect(runExpand({ ...f, contextFiles: { other: f.outputFile } })).rejects.toThrow('Unknown grader context other');
  await expect(runExpand({ ...f, signal: AbortSignal.abort() })).rejects.toThrow();
  await writeFile(f.contextFiles.evidence, '{broken');
  await expect(runExpand(f)).rejects.toThrow();
  await writeFile(f.outputFile, '{broken');
  const errors: string[] = [];
  expect(await main(['grader', 'expand', '--grader', 'grader.yaml', '--output', 'output.json'],
    { cwd: f.root, stdout: () => { throw new Error('unexpected output'); }, stderr: text => errors.push(text) })).toBe(2);
  expect(errors).toHaveLength(1);
});

it('exposes sentence addresses and readiness for cited-row label builders', async () => {
  const f = await fixture();
  const grader = parseGrader({ ...f.grader,
    context: { evidence: { description: 'Evidence rows', rows: { heading: '^### \\[(E\\d+)\\]', cite: '\\[(E\\d+)\\]' } } },
    questions: [{ id: 'q', level: 'sentence', type: 'yes-no', expected: 'yes', reads: ['sentence', 'context.evidence@cited'] }],
  });
  const output = { body: ['A claim [E1]. An uncited claim. Unknown [E9].'] };
  const evidence = 'Preamble\n### [E1]\nKnown fact\n### [E2]\nUncited fact\n';
  await writeFile(f.graderFile, stringify(grader));
  await writeFile(f.outputFile, JSON.stringify(output));
  await writeFile(f.contextFiles.policy, evidence);
  const result = await runExpand({ ...f, contextFiles: { evidence: f.contextFiles.policy } });
  const runtime = expandInstances(grader, output, { evidence });
  expect(result.instances.map(instance => [instance.key, instance.state])).toEqual([
    ['q@p0.s0', 'ready'], ['q@p0.s1', 'not-applicable'], ['q@p0.s2', 'missing'],
  ]);
  expect(result.instances.map(instance => instance.projectionDigest)).toEqual(runtime.map(instance => instance.projectionDigest));
  expect(result.instances[2]?.reason).toContain('E9');
});

it('grader expand prints adjusted sentence units for citations after a period', async () => {
  const f = await fixture();
  const grader = parseGrader({ ...f.grader,
    context: { evidence: { description: 'Evidence rows', rows: {
      heading: '^### \\[(E\\d+)\\]', cite: '\\[(E\\d+)\\]', leading_citations: 'previous',
    } } },
    questions: [{ id: 'q', level: 'sentence', type: 'yes-no', expected: 'yes', reads: ['sentence', 'context.evidence@cited'] }],
  });
  await writeFile(f.graderFile, stringify(grader));
  await writeFile(f.outputFile, JSON.stringify({ body: ['One. [E1][E7] Two. [E2] Three.'] }));
  await writeFile(f.contextFiles.policy, '### [E1]\nFirst\n### [E7]\nOther\n### [E2]\nSecond');
  const printed: string[] = [];
  expect(await main(['grader', 'expand', '--grader', 'grader.yaml', '--output', 'output.json',
    '--context', 'evidence=policy.md'],
  { cwd: f.root, stdout: text => printed.push(text), stderr: text => { throw new Error(text); } })).toBe(0);
  const result = JSON.parse(printed[0]!) as Awaited<ReturnType<typeof runExpand>>;
  expect(result.instances.map(i => [i.key, i.unit.text, i.state])).toEqual([
    ['q@p0.s0', 'One. [E1][E7]', 'ready'], ['q@p0.s1', 'Two. [E2]', 'ready'],
    ['q@p0.s2', 'Three.', 'not-applicable'],
  ]);
});

it('grades on the explicit TypeSafe route with accounting and propagates CLI spend-cap missing reasons', async () => {
  const f = await fixture();
  f.grader.model = { backend: 'typesafe', endpoint: 'https://api.typesafe.ai/v1/systemone', name: 'jev-1.13.0', concurrency: 8 };
  await writeFile(f.graderFile, stringify(f.grader));
  const { graderBackend } = await import('./backend.js');
  vi.stubEnv('TYPESAFE_API_KEY', 'FAKE_GRADE_API_KEY');
  f.calibration.identity = createCalibrationIdentity(f.grader, { ...f.calibration.identity,
    backendModel: await backendIdentity(f.grader, graderBackend(f.grader)) });
  await writeFile(f.grader.calibration, JSON.stringify(f.calibration));
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ model: 'jev-1.13.0',
    answers: { q: { type: 'noul', noul: 0.99 } }, usage: { input_tokens: 100, output_tokens: 1 } }));
  vi.stubGlobal('fetch', fetch);
  const passed = await runGrade(f);
  expect(passed).toMatchObject({ status: 'pass', backendBilling: 'api', decisionAccounting: { requests: 1, inputTokens: 100, outputTokens: 1 } });
  expect(passed.decisionAccounting!.usd).toBeCloseTo(0.0000042, 12);
  const output: string[] = [];
  expect(await main(['grader', 'grade', '--grader', f.graderFile, '--output', f.outputFile,
    '--context', `evidence=${f.contextFiles.evidence}`, '--context', `policy=${f.contextFiles.policy}`, '--max-spend-usd', '0'],
  { cwd: f.root, stdout: text => output.push(text), stderr: text => { throw new Error(text); } })).toBe(1);
  expect(JSON.parse(output[0]!)).toMatchObject({ status: 'unknown', coverage: 0,
    decisions: [{ reason: 'spend cap' }], decisionAccounting: { requests: 0, usd: 0 } });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('emits sanitized accounting for paid grading failure before returning nonzero', async () => {
  const f = await fixture();
  f.backend.capabilities = { billing: 'api' };
  f.backend.score = async (_requests, _signal, receipts) => {
    receipts!.push({ billing: 'api', model: 'paid', endpoint: 'https://example.test', inputTokens: 100,
      outputTokens: 0, usd: 0.1, estimatedInputTokens: 120, estimatedUsd: 0.12, latencyMs: 2, status: 200 });
    throw new Error('infrastructure unavailable');
  };
  const stdout: string[] = [], stderr: string[] = [];
  expect(await main(['grader', 'grade', '--grader', f.graderFile, '--output', f.outputFile,
    '--context', `evidence=${f.contextFiles.evidence}`, '--context', `policy=${f.contextFiles.policy}`], {
    cwd: f.root, stdout: text => stdout.push(text), stderr: text => stderr.push(text),
  }, { grader: f.dependencies })).toBe(2);
  expect(JSON.parse(stdout[0]!)).toMatchObject({ schema: 'paideia.grader-failure.v1', status: 'failed', command: 'grade',
    decisionAccounting: { requests: 1, inputTokens: 100, usd: 0.1, receipts: [{ status: 200 }] } });
  expect(stderr.join('')).toContain('infrastructure unavailable');
});

async function identityFixture() {
  const root = await mkdtemp(join(tmpdir(), 'fixed-questions-')); roots.push(root);
  const graderFile = join(root, 'fixed.yaml'), outputFile = join(root, 'article.json'), groundingFile = join(root, 'grounding.md');
  await writeFile(graderFile, stringify({ schema: 'paideia.grader.v1', id: 'fixed', calibration: 'identity',
    context: { grounding: { description: 'Frozen human facts' } }, model: { backend: 'typesafe', name: 'jev-1.13.0' }, max_spend_usd: 0.5,
    questions: Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, ask: `Reader question ${i}?`,
      type: 'yes-no', expected: i % 2 ? 'no' : 'yes', reads: ['output.body', 'context.grounding'] })),
    score: { method: 'weighted', pass_at: 0.75 } }));
  await writeFile(outputFile, '{"body":["There are 10 items."]}'); await writeFile(groundingFile, 'Exactly 10 items.');
  vi.stubEnv('TYPESAFE_API_KEY', 'FAKE_TEST_KEY');
  const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
    const body = JSON.parse(init!.body as string) as { state: string; questions: Record<string, unknown> };
    expect(JSON.parse(body.state)).toEqual({ 'output.body': ['There are 10 items.'], 'context.grounding': 'Exactly 10 items.' });
    expect(Object.keys(body.questions)).toHaveLength(6);
    return Response.json({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.keys(body.questions).map((key, i) => [key,
      { type: 'noul', noul: i % 2 ? 0.1 : 0.9 }])), usage: { input_tokens: 120, output_tokens: 1 } });
  });
  vi.stubGlobal('fetch', fetch);
  const provider = vi.fn(() => { throw new Error('No teacher or extractor allowed'); });
  return { root, graderFile, outputFile, groundingFile, contextFiles: { grounding: groundingFile }, fetch, provider };
}
it('grades captured files through the real TypeSafe transport with six fixed questions, identity and accounting', async () => {
  const f = await identityFixture();
  expect(await runValidate(f.graderFile)).toEqual({ status: 'valid', calibration: false });
  expect(f.fetch).not.toHaveBeenCalled();
  const result = await runGrade(f, { provider: f.provider });
  expect(result).toMatchObject({ status: 'pass', score: 0.9, coverage: 1, backendBilling: 'api',
    identity: { calibration: { mode: 'identity' } }, decisionAccounting: { requests: 1, inputTokens: 120 } });
  expect(f.provider).not.toHaveBeenCalled(); expect(f.fetch).toHaveBeenCalledOnce();
  const stdout: string[] = [];
  const io = { cwd: f.root, stdout: (line: string) => stdout.push(line), stderr: (line: string) => { throw new Error(line); } };
  expect(await main(['grader', 'grade', '--grader', 'fixed.yaml', '--output', 'article.json', '--context', 'grounding=grounding.md'], io)).toBe(0);
  expect(JSON.parse(stdout[0]!)).toMatchObject({ status: 'pass', identity: { calibration: { mode: 'identity' } } });
  expect(await runGrade({ ...f, maxSpendUsd: 0 })).toMatchObject({ status: 'unknown', coverage: 0,
    decisions: Array.from({ length: 6 }, () => ({ status: 'missing', reason: 'spend cap' })), decisionAccounting: { requests: 0 } });
  await expect(runCalibrate({ graderFile: f.graderFile })).rejects.toThrow('no fitted calibration');
});
it('resolves per-record grading, freezes source files, and evaluates grounding without exposing it as subject input', async () => {
  const f = await identityFixture();
  await writeFile(join(f.root, 'facts.md'), 'There are 10 items.');
  await writeFile(join(f.root, 'data.yaml'), stringify({ schema: 'paideia.dataset.v1', id: 'cases',
    records: [{ id: 'r', input: { prompt: 'Write.' }, outputs: { article: 'article.json' }, context: { grounding: 'Exactly 10 items.' }, checks: [
      { id: 'length', eval: 'word-count', input: 'artifact:article#/body', min: 4, max: 4 },
      { id: 'values', eval: 'values-in-source', input: 'artifact:article#/body', source: ['context:grounding', 'facts.md'] },
      { id: 'reader', eval: 'grader', grader: 'fixed.yaml', input: 'artifact:article', context: { grounding: 'context:grounding' } },
    ] }] }));
  const datasets = new CliDatasets({}, f.root);
  const resolved = datasets.load('data.yaml', false);
  const graders = await datasets.buildGraders({ provider: f.provider }, true);
  const record = resolved.records[0]!;
  expect(record.input).toEqual({ prompt: 'Write.' });
  await writeFile(join(f.root, 'facts.md'), 'Mutated');
  expect(await datasets.readCriterion('facts.md')).toBe('There are 10 items.');
  const result = await evaluatePlan(record.effectiveStages, evaluationContext({ graders, readText: name => datasets.readCriterion(name),
    snapshot: snapshot({ context: record.context!, artifacts: { article: artifact(JSON.parse(await readFile(f.outputFile, 'utf8'))) } }) }), createEvaluationRegistry());
  expect(result.status).toBe('pass'); expect(result.checks.reader).toMatchObject({ grading: { score: 0.9 } });
  expect(f.provider).not.toHaveBeenCalled(); expect(f.fetch).toHaveBeenCalledOnce();
  await writeFile(f.graderFile, (await readFile(f.graderFile, 'utf8')).replace('Reader question 0?', 'Changed question?'));
  await expect(datasets.buildGraders({}, true)).rejects.toThrow('changed after dataset resolution');
});
