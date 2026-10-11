import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { createCalibrationIdentity, loadGrader, loadLabels, parseGrader } from '../../graders/index.js';
import type { DecisionBackend, DecisionRequest } from '../../contracts/grading.js';
import { DECISION_PROMPT_VERSION } from '../../inference/decision/index.js';
import { main } from '../commands.js';
import { backendIdentity } from './backend.js';
import { runGrade } from './grade.js';

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
