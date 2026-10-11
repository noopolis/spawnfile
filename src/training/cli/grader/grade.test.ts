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
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
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
