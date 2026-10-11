import { appendFile, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { allQuestions, expandInstances, parseGrader, splitCalibration, stableDigest, type Grader } from '../../graders/index.js';
import type { DecisionBackend, DecisionRequest, DecisionResult } from '../../contracts/grading.js';
import { runCalibrate } from './calibrate.js';
import { runValidate } from './validate.js';
import { graderBackends } from './backend.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, appendFile: vi.fn(actual.appendFile) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.mocked(appendFile).mockReset();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
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

it('finishes candidate A scoring and cache writes before constructing candidate B', async () => {
  const f = await fixture(), started = latch(), releaseScore = latch();
  const lastAppend = latch(), releaseAppend = latch();
  const append = vi.mocked(appendFile).getMockImplementation()!;
  let writes = 0;
  vi.mocked(appendFile).mockImplementation(async (...args) => {
    if (++writes === 160) { lastAppend.release(); await releaseAppend.promise; }
    await append(...args);
  });
  const score = f.backends.a!.score.getMockImplementation()!;
  let completed = 0;
  f.backends.a!.score.mockImplementation(async requests => {
    started.release();
    await releaseScore.promise;
    const results = await score(requests);
    completed += requests.length;
    return results;
  });
  const events: string[] = [];
  const factory = (view: Grader): DecisionBackend => {
    const id = (view.model as { name: string }).name;
    events.push(`${id}:${completed}`);
    if (id === 'b') throw new Error('unavailable');
    return f.backends.a!;
  };
  const operation = runCalibrate({ graderFile: f.graderFile }, { backend: factory }).catch(error => error);
  try {
    await started.promise;
    expect(events).toEqual(['a:0']);
    releaseScore.release();
    await lastAppend.promise;
    expect(completed).toBe(160);
    expect(events).toEqual(['a:0']);
  } finally { releaseScore.release(); releaseAppend.release(); await operation; }
  expect(await operation).toMatchObject({ message: 'Decision model b: unavailable' });
  expect(events).toEqual(['a:0', 'b:160']);
  const appends = vi.mocked(appendFile).mock.results;
  expect(appends).toHaveLength(160);
  await expect(Promise.all(appends.map(call => call.value))).resolves.toHaveLength(160);
  const calls = f.backends.a!.score.mock.calls.length;
  await nextTurn();
  expect(f.backends.a!.score).toHaveBeenCalledTimes(calls);
  expect(appendFile).toHaveBeenCalledTimes(160);
});

it.each(['score', 'append', 'caller'] as const)('drains all scoring and cache workers on %s failure before rejecting', async source => {
  const f = await fixture(), controller = new AbortController();
  const scoreStarted = latch(), appendStarted = latch(), failureRaised = latch(), fail = latch();
  const releaseScore = latch(), releaseAppend = latch(), scoreFinished = latch();
  const failure = new Error(`${source} failure`), events: string[] = [], signals: AbortSignal[] = [];
  let scores = 0, appends = 0, activeScores = 0, activeAppends = 0, settled = false;
  const backend: DecisionBackend = {
    identity: f.backends.a!.identity,
    async score(requests, signal) {
      const position = ++scores;
      activeScores++;
      signals.push(signal!);
      try {
        if (position === 2) {
          scoreStarted.release();
          // Deliberately ignore cancellation until released: the owner must still drain us.
          await releaseScore.promise;
          events.push('score finished');
          scoreFinished.release();
        } else if (position === 3) {
          await fail.promise;
          if (source === 'score') { failureRaised.release(); throw failure; }
          if (source === 'caller') { controller.abort(failure); failureRaised.release(); signal!.throwIfAborted(); }
        }
        return requests.map(request => ({ key: request.key, status: 'ok', probabilities: { yes: 0.8, no: 0.2 } }));
      } finally { activeScores--; }
    },
  };
  vi.mocked(appendFile).mockImplementation(async () => {
    const position = ++appends;
    activeAppends++;
    try {
      if (position === 1) {
        appendStarted.release();
        await releaseAppend.promise;
        events.push('append finished');
      } else if (source === 'append') { failureRaised.release(); throw failure; }
    } finally { activeAppends--; }
  });
  const factory = vi.fn(() => backend);
  const operation = runCalibrate({ graderFile: f.graderFile, concurrency: 3, signal: controller.signal }, { backend: factory })
    .then(value => { settled = true; return value; }, error => { settled = true; events.push('rejected'); return error; });
  try {
    await Promise.all([scoreStarted.promise, appendStarted.promise]);
    fail.release();
    await failureRaised.promise;
    await nextTurn();
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(controller.signal.aborted).toBe(source === 'caller');
    expect(settled).toBe(false);
    releaseScore.release();
    await scoreFinished.promise;
    await nextTurn();
    expect(settled).toBe(false);
    expect(activeScores).toBe(0);
    expect(activeAppends).toBe(1);
    releaseAppend.release();
    expect(await operation).toMatchObject({ message: `Decision model a: ${source} failure`, cause: failure });
    expect(events).toEqual(['score finished', 'append finished', 'rejected']);
    expect(activeScores + activeAppends).toBe(0);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(scores).toBe(3);
    expect(appends).toBe(source === 'append' ? 2 : 1);
    await nextTurn();
    expect(events).toEqual(['score finished', 'append finished', 'rejected']);
    await expect(readFile(join(f.root, 'calibration.json'))).rejects.toThrow('ENOENT');
  } finally {
    fail.release(); releaseScore.release(); releaseAppend.release();
    await operation;
  }
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
