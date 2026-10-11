import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { DecisionBackend, DecisionRequest } from '../../contracts/grading.js';
import { main } from '../commands.js';
import { parseGrader, parseLabels, stableDigest, allQuestions, splitCalibration, fitPlatt, type Labels } from '../../graders/index.js';
import { teacherPolicyDigest } from '../../graders/labeling/index.js';
import { runCalibrate } from './calibrate.js';
import { runValidate } from './validate.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(backend = 'jev-http', count = 80) {
  const root = await mkdtemp(join(tmpdir(), 'grader-calibration-')); roots.push(root);
  const graderFile = join(root, 'grader.yaml');
  const grader = parseGrader({ schema: 'paideia.grader.v1', id: 'quality', golden: 'labels.yaml', calibration: 'calibration.json',
    teachers: [{ id: 'teacher', provider: 'claude', model: 'opus' }],
    model: backend === 'teacher' ? { backend, teacher: 'teacher' } : { backend, endpoint: 'http://localhost:11434', name: 'model' },
    escalate: { to: 'teacher', between: [0.4, 0.6], max_calls_per_trial: 1 },
    gates: [{ id: 'gate', type: 'yes-no', expected: 'yes', reads: ['output.good'] }],
    questions: [{ id: 'q', type: 'yes-no', expected: 'yes', reads: ['output.good'], ask: 'Is it good?' }], score: { method: 'weighted' } });
  const labels = parseLabels({ schema: 'paideia.labels.v1', grader: 'quality', labelers: { human: { kind: 'human', name: 'Reader' } },
    labels: Array.from({ length: count }, (_, i) => ({ id: `o${i}`, lineage: `g${i}`, example: { dataset: 'train', id: `e${i}` },
      output: { good: i % 2 === 0 }, context: {}, votes: { q: { human: i % 2 === 0 ? 'yes' : 'no' }, gate: { human: i % 2 === 0 ? 'yes' : 'no' } }, provenance: { human: { votes: Object.fromEntries(allQuestions(grader).map(question => [question.id, {
        question_digest: stableDigest(question), projection_digest: stableDigest({ 'output.good': i % 2 === 0 }),
      }])) } } })) }, grader);
  await writeFile(graderFile, stringify(grader)); await writeFile(join(root, 'labels.yaml'), stringify(labels));
  const score = vi.fn(async (requests: DecisionRequest[]) => requests.map(request => {
    const good = request.projection['output.good'] === true;
    const yes = backend === 'teacher' ? Number(good) : good ? 0.98 : 0.02;
    return { key: request.key, status: 'ok' as const, probabilities: { yes, no: 1 - yes }, bounded: JSON.parse(request.key)[0] === 'o0' };
  }));
  const runtime: DecisionBackend = { identity: async () => ({ backend, model: 'reported', digest: 'digest' }), score };
  return { root, graderFile, grader, labels, score, runtime, dependencies: { backend: () => runtime } };
}

describe('grader calibration commands', () => {
  it('calibrates, writes complete local artifacts, reuses raw scores and validates fresh identity', async () => {
    const f = await fixture();
    const result = await runCalibrate({ graderFile: f.graderFile, seed: 'seed', reportFile: join(f.root, 'reports/report.md'), concurrency: 3 }, f.dependencies);
    expect(result.code).toBe(0);
    expect(result.calibration.questions.q).toMatchObject({ status: 'calibrated', band: [0.4, 0.6] });
    const report = await readFile(result.reportFile, 'utf8');
    expect(report).toContain('Human / consensus / single'); expect(report).toContain('human: n=');
    expect(report).toContain('not validated correctness');
    const calls = f.score.mock.calls.length;
    expect((await runCalibrate({ graderFile: f.graderFile, seed: 'seed' }, f.dependencies)).code).toBe(0);
    expect(f.score).toHaveBeenCalledTimes(calls);
    expect(await runValidate(f.graderFile, f.dependencies)).toEqual({ status: 'valid', calibration: true });
    f.grader.questions[0]!.ask = 'Changed'; await writeFile(f.graderFile, stringify(f.grader));
    await expect(runValidate(f.graderFile, f.dependencies)).rejects.toThrow('re-adjudicate');
    await expect(runCalibrate({ graderFile: f.graderFile }, f.dependencies)).rejects.toThrow('re-adjudicate');
  });

  it('validates before calibration without contacting a model, and rejects changed golden/exclusions/backend identities', async () => {
    const f = await fixture();
    const factory = vi.fn(() => f.runtime);
    expect(await runValidate(f.graderFile, { backend: factory })).toEqual({ status: 'valid', calibration: false });
    expect(factory).not.toHaveBeenCalled();
    const excluded = join(f.root, 'test.yaml');
    await writeFile(excluded, stringify({ schema: 'paideia.dataset.v1', id: 'train', records: [{ id: 'e0' }] }));
    const first = await runCalibrate({ graderFile: f.graderFile, excludeDatasets: [excluded] }, f.dependencies);
    expect(first.calibration.identity.exclusions).toHaveLength(1);
    expect(f.score.mock.calls.flatMap(call => call[0]).every(request => JSON.parse(request.key)[0] !== 'o0')).toBe(true);
    await writeFile(excluded, stringify({ schema: 'paideia.dataset.v1', records: [{ id: 'e1' }] }));
    await expect(runValidate(f.graderFile, f.dependencies)).rejects.toThrow('exclusions');
    await runCalibrate({ graderFile: f.graderFile }, f.dependencies);
    f.runtime.identity = async () => ({ backend: 'jev-http', model: 'different' });
    await expect(runValidate(f.graderFile, f.dependencies)).rejects.toThrow('backendModel');
    await writeFile(join(f.root, 'calibration.json'), '{bad');
    await expect(runValidate(f.graderFile, f.dependencies)).rejects.toThrow();
    await rm(join(f.root, 'calibration.json')); await mkdir(join(f.root, 'calibration.json'));
    await expect(runValidate(f.graderFile, f.dependencies)).rejects.toThrow();
  });

  it('excludes all revisions of dataset group lineage before backend calls and splitting', async () => {
    const f = await fixture();
    f.labels.labels[0]!.lineage = 'story-7';
    delete f.labels.labels[0]!.example;
    f.labels.labels[1]!.lineage = 'story-7';
    delete f.labels.labels[1]!.example;
    await writeFile(join(f.root, 'labels.yaml'), stringify(f.labels));
    const excluded = join(f.root, 'sealed.yaml');
    await writeFile(excluded, stringify({ schema: 'paideia.dataset.v1', id: 'sealed', records: [{ id: 'story-7-r2', group: 'story-7' }] }));
    const result = await runCalibrate({ graderFile: f.graderFile, excludeDatasets: [excluded] }, f.dependencies);
    const requests = f.score.mock.calls.flatMap(call => call[0]);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.some(request => ['o0', 'o1'].includes(JSON.parse(request.key)[0]))).toBe(false);
    expect(result.calibration.questions.q!.metrics.groups).toBe(39);
  });

  it('propagates calibration cancellation to identity and scoring before writing artifacts', async () => {
    const f = await fixture(); const controller = new AbortController();
    const identity = f.runtime.identity;
    let probed = false, scored = false;
    f.runtime.identity = async signal => { expect(signal).toBe(controller.signal); probed = true; return identity(signal); };
    f.runtime.score = async (_requests, signal) => {
      expect(signal).toBe(controller.signal); scored = true;
      controller.abort(new Error('calibration deadline')); signal!.throwIfAborted(); return [];
    };
    await expect(runCalibrate({ graderFile: f.graderFile, signal: controller.signal }, f.dependencies)).rejects.toThrow('calibration deadline');
    expect(probed && scored).toBe(true);
    await expect(readFile(join(f.root, 'calibration.json'))).rejects.toThrow('ENOENT');
  });

  it('reports missing scores, disputed labels and unavailable projections without inventing evidence', async () => {
    const f = await fixture('jev-http', 8);
    f.labels.labels[0]!.votes = {};
    f.labels.labels[1]!.output = {};
    f.labels.labels[1]!.votes = {};
    await writeFile(join(f.root, 'labels.yaml'), stringify(f.labels));
    f.runtime.score = async requests => requests.map(request => ({ key: request.key, status: 'missing', probabilities: null }));
    const result = await runCalibrate({ graderFile: f.graderFile }, f.dependencies);
    expect(result.code).toBe(1); expect(result.calibration.questions.q!.status).toBe('insufficient-evidence');
    const report = await readFile(result.reportFile, 'utf8');
    expect(report).toContain('disputed instances: 2'); expect(report).toContain('unavailable projections: 2');
    expect(report).toContain('1.000 / 0.000');
  });

  it('reports uncalibrated metrics and measured permutation sensitivity without changing fit selection', async () => {
    const f = await fixture('ollama-logprobs');
    f.runtime.score = async requests => requests.map(request => ({ key: request.key, status: 'ok', probabilities:
      request.optionLabels[0] === 'yes' ? { yes: 0.5, no: 0.5 } : { yes: 0.1, no: 0.9 } }));
    const result = await runCalibrate({ graderFile: f.graderFile }, f.dependencies);
    expect(result.code).toBe(1); expect(result.calibration.questions.q!.status).not.toBe('calibrated');
    expect(await readFile(result.reportFile, 'utf8')).toContain('decision flip rate 1.000');
  });

  it('reports teacher-only independent agreement with no ECE, keeping missing answers in denominator', async () => {
    const f = await fixture('teacher');
    let result = await runCalibrate({ graderFile: f.graderFile }, f.dependencies);
    expect(result.code).toBe(0); expect(result.calibration.questions.q!.metrics.agreement).toBe(1);
    expect(result.calibration.questions.q!.metrics).toMatchObject({ cascadeAccuracy: 1, coverage: 0 });
    expect(result.calibration.questions.q!.metrics.ece).toBeUndefined();
    await rm(join(f.root, '.paideia'), { recursive: true });
    f.runtime.score = async requests => requests.map(request => ({ key: request.key, status: 'missing', probabilities: null }));
    result = await runCalibrate({ graderFile: f.graderFile }, f.dependencies);
    expect(result.code).toBe(1); expect(result.calibration.questions.q!.metrics.instances).toBe(40);
    expect(result.calibration.questions.q!.metrics.agreement).toBe(0);
  });

  it('keeps the golden split fixed across backend missingness and reports empty questions', async () => {
    const f = await fixture();
    f.labels.labelers.teacher = { kind: 'model', provider: 'claude', model: 'opus' };
    for (const label of f.labels.labels) {
      label.votes.q!.teacher = label.votes.q!.human!;
      const q = f.grader.questions[0]!;
      label.provenance.teacher = { votes: { q: { question_digest: stableDigest(q),
        teacher_policy_digest: teacherPolicyDigest(f.grader.teachers[0]!),
        projection_digest: stableDigest({ 'output.good': (label.output as { good: boolean }).good }) } } };
    }
    await writeFile(join(f.root, 'labels.yaml'), stringify(f.labels));
    const normal = f.runtime.score;
    f.runtime.score = async (requests, signal) => (await normal(requests, signal)).map(result =>
      JSON.parse(result.key)[0] === 'o0' ? { key: result.key, status: 'missing' as const, probabilities: null } : result);
    const result = await runCalibrate({ graderFile: f.graderFile }, f.dependencies);
    expect(result.calibration.questions.q!.metrics.instances).toBe(40);
    const empty = await fixture('ollama-logprobs', 0);
    const emptyResult = await runCalibrate({ graderFile: empty.graderFile }, empty.dependencies);
    expect(emptyResult.calibration.questions.q!.status).toBe('insufficient-evidence');
  });

  it('reserves forced-teacher calls before simulating the held-out budget for later questions', async () => {
    const f = await fixture();
    f.grader.uncalibrated = 'teacher';
    // The first question has no golden truth, yet its ready projection consumes
    // a forced-teacher call before the later gate can escalate.
    const gate = f.grader.gates[0]!;
    if ('check' in gate) throw Error('Expected question gate');
    f.grader.questions[0]!.reads = ['output.other'];
    f.labels.labelers.teacher = { kind: 'model', provider: 'claude', model: 'opus' };
    for (const label of f.labels.labels) {
      const good = (label.output as { good: boolean }).good;
      (label.output as { good: boolean; other: boolean }).other = good;
      label.votes.q = {};
      label.votes.gate!.teacher = good ? 'yes' : 'no';
      const votes = Object.fromEntries(allQuestions(f.grader).map(question => [question.id, {
        question_digest: stableDigest(question),
        projection_digest: stableDigest({ [question.id === 'q' ? 'output.other' : 'output.good']: good }),
      }]));
      label.provenance.human = { votes };
      label.provenance.teacher = { votes: Object.fromEntries(Object.entries(votes).map(([key, value]) =>
        [key, { ...value, teacher_policy_digest: teacherPolicyDigest(f.grader.teachers[0]!) }])) };
    }
    await writeFile(f.graderFile, stringify(f.grader));
    await writeFile(join(f.root, 'labels.yaml'), stringify(f.labels));
    f.runtime.score = async requests => requests.map(request => JSON.parse(request.key)[1] === 'q'
      ? { key: request.key, status: 'missing', probabilities: null }
      : { key: request.key, status: 'ok', probabilities: { yes: 0.5, no: 0.5 } });
    const result = await runCalibrate({ graderFile: f.graderFile }, f.dependencies);
    expect(result.calibration.questions.gate!.metrics.cascadeAccuracy).toBe(0);
    expect(result.calibration.questions.q!.status).toBe('insufficient-evidence');
    const report = await readFile(result.reportFile, 'utf8');
    expect(report).toContain('"overflowCalls": 40');
  });

  it('refuses backend identity drift and cancellation before publishing calibration', async () => {
    const f = await fixture('teacher', 0);
    let n = 0;
    f.runtime.identity = async () => ({ backend: 'teacher', model: String(n++) });
    await expect(runCalibrate({ graderFile: f.graderFile }, f.dependencies)).rejects.toThrow('identity changed');
    await expect(readFile(join(f.root, 'calibration.json'))).rejects.toThrow();
    await expect(runCalibrate({ graderFile: f.graderFile, signal: AbortSignal.abort() }, f.dependencies)).rejects.toThrow();
  });

  it('dispatches public CLI validate/calibrate/label with exit codes and strict flags', async () => {
    const f = await fixture('jev-http', 2);
    const output: string[] = [], errors: string[] = [];
    const io = { cwd: f.root, stdout: (text: string) => output.push(text), stderr: (text: string) => errors.push(text) };
    expect(await main(['grader', 'validate', '--grader', 'grader.yaml'], io, { grader: f.dependencies })).toBe(0);
    await writeFile(join(f.root, 'excluded.yaml'), stringify({ schema: 'paideia.dataset.v1', records: [] }));
    expect(await main(['grader', 'calibrate', '--grader', 'grader.yaml', '--seed', 'custom', '--report', 'report.md', '--concurrency', '1', '--exclude-dataset', 'excluded.yaml'], io,
      { grader: f.dependencies })).toBe(1);
    expect(output.join('')).toContain('report.md');
    expect(await main(['grader', 'calibrate', '--grader', 'grader.yaml'], io, { grader: f.dependencies })).toBe(1);
    expect(await main(['grader', 'label', '--grader', 'grader.yaml', '--inputs', 'missing', '--teachers', 'teacher', '--limit', '1', '--adjudication', '0'], io)).toBe(2);
    expect(await main(['grader', 'calibrate', '--grader', 'grader.yaml', '--concurrency', '0'], io)).toBe(2);
    expect(errors.join('')).toContain('concurrency');
    // Exercise actual label entry point with a fake subscription provider.
    await writeFile(join(f.root, 'output.json'), JSON.stringify({ good: true }));
    await writeFile(join(f.root, 'inputs.yaml'), stringify({ schema: 'paideia.grader-inputs.v1', items: [{ id: 'new', lineage: 'new', output: { from: 'output.json' }, context: {} }] }));
    const provider = { id: 'claude', capabilities: { tools: 'disabled' as const, billing: 'subscription' as const, temperature: false, seed: false },
      generate: async () => ({ text: '{"q":"yes","gate":"yes"}', model: 'opus', route: 'claude', usage: null }) };
    expect(await main(['grader', 'label', '--grader', 'grader.yaml', '--inputs', 'inputs.yaml', '--teachers', 'teacher', '--relabel', '--limit', '1'], io,
      { grader: { provider: () => provider } })).toBe(0);
    const labels = (await import('yaml')).parse(await readFile(join(f.root, 'labels.yaml'), 'utf8')) as Labels;
    expect(labels.labels.at(-1)!.votes.q!.teacher).toBe('yes');
    provider.generate = async () => ({ text: '{}', model: 'opus', route: 'claude', usage: null });
    expect(await main(['grader', 'label', '--grader', 'grader.yaml', '--inputs', 'inputs.yaml', '--teachers', 'teacher', '--relabel'], io,
      { grader: { provider: () => provider } })).toBe(1);
  });
});

it('persists null ECE and prints an em dash for six held-out instances', async () => {
  const f = await fixture('jev-http', 12);
  const result = await runCalibrate({ graderFile: f.graderFile }, f.dependencies);
  expect(result.calibration.questions.q).toMatchObject({ status: 'insufficient-evidence', metrics: { instances: 6, ece: null, eceInterval: null } });
  expect(JSON.parse(await readFile(result.calibrationFile, 'utf8')).questions.q.metrics.ece).toBeNull();
  expect(await readFile(result.reportFile, 'utf8')).toContain('ECE=—');
});

it('keeps colliding legacy request pairs attached to their own evidence through calibration', async () => {
  const f = await fixture('teacher', 2);
  f.grader.gates = [];
  f.grader.questions = ['c', 'b:c'].map(id => ({ ...structuredClone(f.grader.questions[0]!), id, ask: id }));
  f.labels.labels.forEach((label, i) => {
    label.id = i === 0 ? 'a:b' : 'a';
    label.votes = Object.fromEntries(f.grader.questions.map(q => [q.id, { human: i === 0 ? 'yes' : 'no' }]));
    label.provenance = { human: { votes: Object.fromEntries(f.grader.questions.map(q => [q.id, {
      question_digest: stableDigest(q), projection_digest: stableDigest({ 'output.good': i === 0 }),
    }])) } };
  });
  await writeFile(f.graderFile, stringify(f.grader));
  await writeFile(join(f.root, 'labels.yaml'), stringify(f.labels));
  // Both split choices must preserve independent agreement; the legacy collision corrupts one side.
  for (const seed of ['0', '1', '2', '3']) {
    const result = await runCalibrate({ graderFile: f.graderFile, seed }, f.dependencies);
    expect(result.calibration.questions.c!.metrics.agreement).toBe(1);
    expect(result.calibration.questions['b:c']!.metrics.agreement).toBe(1);
  }
  expect(new Set(f.score.mock.calls.flatMap(([requests]) => requests.map(r => r.key))).size).toBe(4);
});

it('splits before panel disputes and verifies every independently answerable held-out instance', async () => {
  const f = await fixture('jev-http', 400);
  f.grader.gates = [];
  f.grader.teachers.push({ id: 'other', provider: 'grok', model: 'm' });
  f.grader.escalate = { to: 'teacher', target_accuracy: 0.9, max_calls_per_trial: 1 };
  f.labels.labelers = Object.fromEntries(f.grader.teachers.map(t => [t.id, { kind: 'model', provider: t.provider, model: t.model }]));
  f.labels.labels.forEach((label, index) => {
    const good = (label.output as { good: boolean }).good;
    label.askedByInstance = { q: ['teacher', 'other'] };
    label.votes = { q: { teacher: good ? 'yes' : 'no', other: (index < 200 ? good : !good) ? 'yes' : 'no' } };
    label.provenance = Object.fromEntries(f.grader.teachers.map(t => [t.id, { votes: { q: {
      question_digest: stableDigest(f.grader.questions[0]!), teacher_policy_digest: teacherPolicyDigest(t),
      projection_digest: stableDigest({ 'output.good': good }),
    } } }]));
  });
  await writeFile(f.graderFile, stringify(f.grader));
  await writeFile(join(f.root, 'labels.yaml'), stringify(f.labels));
  const population = f.labels.labels.map((label, index) => ({ questionId: 'q', type: 'yes-no' as const,
    group: label.lineage, good: index % 2 === 0, rawPGood: index % 2 === 0 ? 0.98 : 0.02,
    source: 'consensus' as const, disputed: index >= 200 }));
  const split = splitCalibration(population, '0');
  const result = await runCalibrate({ graderFile: f.graderFile }, f.dependencies);
  const q = result.calibration.questions.q!;
  expect(result.code).toBe(1);
  expect(q.status).toBe('escalation-infeasible');
  expect(q.metrics.cascadeAccuracy).toBe(split.heldOut.filter(row => !row.disputed).length / 200);
  expect(q.metrics.instances).toBe(split.heldOut.filter(row => !row.disputed).length);
  const params = fitPlatt(split.fit.filter(row => !row.disputed));
  expect(q.params).toEqual({ a: params.a, b: params.b });
  expect(q.failures).toContain('heldOut.cascadeAccuracy >= target_accuracy');
});

it('enforces the cascade Wilson bar for the forced teacher backend without a retention bar', async () => {
  const f = await fixture('teacher', 60);
  f.grader.gates = [];
  f.grader.escalate = { to: 'teacher', target_accuracy: 1 };
  f.grader.questions[0]!.reads.push('output.id');
  for (const label of f.labels.labels) {
    delete label.votes.gate;
    (label.output as Record<string, unknown>).id = label.id;
    label.provenance.human = { votes: { q: {
      question_digest: stableDigest(f.grader.questions[0]!),
      projection_digest: stableDigest({ 'output.good': (label.output as { good: boolean }).good, 'output.id': label.id }),
    } } };
  }
  await writeFile(join(f.root, 'labels.yaml'), stringify(f.labels));
  await writeFile(f.graderFile, stringify(f.grader));
  const normal = f.runtime.score;
  // At 30 held-out groups, one wrong answer passes 0.85 agreement but fails the cascade bounds.
  f.runtime.score = async (requests, signal) => (await normal(requests, signal)).map(result => {
    const index = Number(JSON.parse(result.key)[0].slice(1));
    return index < 4 ? { ...result, probabilities: { yes: result.probabilities!.no!, no: result.probabilities!.yes! } } : result;
  });
  const result = await runCalibrate({ graderFile: f.graderFile }, f.dependencies);
  expect(result.calibration.questions.q!.metrics.agreement).toBeGreaterThanOrEqual(0.85);
  expect(result.calibration.questions.q!.failures).toContain('heldOut.cascade90Lower >= target_accuracy - 0.10');
  expect(result.calibration.questions.q!.failures).not.toContain('heldOut.retainedCoverage >= 0.30');
  expect(result.code).toBe(1);
});
