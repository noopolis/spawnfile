import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { allQuestions, expandInstances, parseGrader, splitCalibration, stableDigest, type Grader } from '../../graders/index.js';
import type { DecisionBackend, DecisionRequest, DecisionResult } from '../../contracts/grading.js';
import { runCalibrate } from './calibrate.js';
import { runValidate } from './validate.js';
import { graderBackends } from './backend.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'grader-models-')); roots.push(root);
  const graderFile = join(root, 'grader.yaml');
  const grader = parseGrader({ schema: 'paideia.grader.v1', id: 'g', golden: 'labels.yaml', calibration: 'calibration.json',
    teachers: [{ id: 't', provider: 'claude', model: 'teacher' }],
    models: ['a', 'b'].map(id => ({ id, backend: 'jev-http', endpoint: `http://localhost/${id}`, name: id })),
    escalate: { to: 't', between: [0.4, 0.6] },
    questions: ['q', 'r'].map(id => ({ id, ask: id, type: 'yes-no', expected: 'yes', reads: ['output.good', 'output.id'] })),
    score: { method: 'weighted' } });
  const population = Array.from({ length: 80 }, (_, i) => ({ questionId: 'q', type: 'yes-no' as const,
    group: `g${i}`, good: i % 2 === 0, rawPGood: 0.5, source: 'human' as const }));
  const split = splitCalibration(population, '0');
  const fit = new Set(split.fit.map(row => row.group));
  const labels = { schema: 'paideia.labels.v1', grader: 'g', labelers: { h: { kind: 'human', name: 'Human' } },
    labels: population.map((row, i) => {
      const output = { id: row.group, good: row.good };
      const instances = expandInstances(grader, output);
      return { id: `o${i}`, lineage: row.group, output, context: {},
        votes: Object.fromEntries(allQuestions(grader).map(q => [q.id, { h: row.good ? 'yes' : 'no' }])),
        provenance: { h: { votes: Object.fromEntries(allQuestions(grader).map(q => [q.id, {
          question_digest: stableDigest(q), projection_digest: instances.find(instance => instance.questionId === q.id)!.projectionDigest,
        }])) } } };
    }) };
  await writeFile(graderFile, stringify(grader));
  await writeFile(join(root, 'labels.yaml'), stringify(labels));
  const backends = Object.fromEntries(['a', 'b'].map(id => [id, {
    identity: vi.fn(async () => ({ backend: 'jev-http', model: id })),
    score: vi.fn(async (requests: DecisionRequest[]): Promise<DecisionResult[]> => requests.map(request => {
      const isFit = fit.has(String(request.projection['output.id']));
      const bestFit = request.instructions === 'q' ? 'a' : 'b';
      // Held-out prefers the opposite candidate. A held-out selection mutation must fail.
      const correct = isFit ? id === bestFit : id !== bestFit;
      const good = request.projection['output.good'] === true;
      const yes = correct ? (good ? 0.98 : 0.02) : 0.5;
      return { key: request.key, status: 'ok' as const, probabilities: { yes, no: 1 - yes } };
    })),
  }]));
  const factory = vi.fn((view: Grader) => backends[(view.model as { name: string }).name]!);
  return { root, graderFile, grader, backends, factory, fit, dependencies: { backend: factory } };
}

it('selects on fit only per question, persists identities and reports nonselection metrics', async () => {
  const f = await fixture();
  const result = await runCalibrate({ graderFile: f.graderFile }, f.dependencies);
  expect(result.calibration.questions.q!.model).toBe('a');
  expect(result.calibration.questions.r!.model).toBe('b');
  expect(result.calibration.questions.q!.status).not.toBe('calibrated');
  expect(result.calibration.identity.modelIdentities).toEqual({ a: expect.any(String), b: expect.any(String) });
  expect(f.factory).toHaveBeenCalledTimes(2);
  expect(f.backends.a!.score.mock.calls.flatMap(([requests]) => requests)).toHaveLength(160);
  expect(f.backends.b!.score.mock.calls.flatMap(([requests]) => requests)).toHaveLength(160);
  const report = await readFile(result.reportFile, 'utf8');
  expect(report).toContain('Selected model: a');
  expect(report).toContain('Selected model: b');
  expect(report).toMatch(/Candidate a held-out ECE=.*Brier=.*\(not used for selection\)/);
  expect(report).toMatch(/Candidate b held-out ECE=.*\(not used for selection\)/);
  await runValidate(f.graderFile, f.dependencies);
  f.backends.a!.score.mockClear(); f.backends.b!.score.mockClear();
  await runCalibrate({ graderFile: f.graderFile }, f.dependencies);
  expect(f.backends.a!.score).not.toHaveBeenCalled();
  expect(f.backends.b!.score).not.toHaveBeenCalled();
});

it('retains missing fit answers in comparison instead of rewarding an abstaining model', async () => {
  const f = await fixture();
  f.backends.a!.score.mockImplementation(async requests => requests.map(request => {
    const good = request.projection['output.good'] === true;
    return good ? { key: request.key, status: 'ok', probabilities: { yes: 0.99, no: 0.01 } }
      : { key: request.key, status: 'missing', probabilities: null };
  }));
  const result = await runCalibrate({ graderFile: f.graderFile }, f.dependencies);
  expect(result.calibration.questions.q!.model).toBe('b');
});

it('names a model that cannot start, refuses identity drift, and never silently drops it', async () => {
  const f = await fixture();
  const dependencies = { backend: (view: Grader): DecisionBackend => {
    if ((view.model as { name: string }).name === 'b') throw Error('unavailable');
    return f.backends.a!;
  } };
  expect(() => graderBackends(f.grader, dependencies)).toThrow('Decision model b');
  expect(Object.keys(graderBackends(f.grader, dependencies, new Set(['a'])))).toEqual(['a']);
  await expect(runCalibrate({ graderFile: f.graderFile }, dependencies)).rejects.toThrow('Decision model b: unavailable');
  await expect(readFile(join(f.root, 'calibration.json'))).rejects.toThrow('ENOENT');
  f.backends.b!.identity.mockRejectedValue(Error('offline'));
  await expect(runCalibrate({ graderFile: f.graderFile }, f.dependencies)).rejects.toThrow('Decision model b: offline');
});

it('selects a teacher candidate without claiming ECE and preserves independent truth', async () => {
  const f = await fixture();
  f.grader.models![1] = { id: 'b', backend: 'teacher', teacher: 't' };
  await writeFile(f.graderFile, stringify(f.grader));
  const backend: DecisionBackend = { identity: async () => ({ backend: 'teacher', model: 'teacher' }),
    score: async requests => requests.map(request => ({ key: request.key, status: 'ok', probabilities: {
      yes: Number(request.projection['output.good']), no: Number(!request.projection['output.good']),
    } })) };
  const result = await runCalibrate({ graderFile: f.graderFile }, { backend: view => view.model!.backend === 'teacher' ? backend : f.backends.a! });
  expect(result.calibration.questions.q).toMatchObject({ model: 'b', status: 'calibrated', metrics: { agreement: 1 } });
  expect(result.calibration.questions.q!.metrics.ece).toBeUndefined();
  expect(await readFile(result.reportFile, 'utf8')).toContain('Candidate b held-out ECE=—, Brier=— (not used for selection)');
});
