import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { DecisionBackend, DecisionRequest } from '../../contracts/grading.js';
import { parseGrader, stableDigest } from '../format/index.js';
import { createCalibrationIdentity } from '../identity.js';
import { gradeOutput, decisionModelIdentities, createGradeResultSchema, type GradeOptions } from './index.js';

async function fixture(): Promise<GradeOptions> {
  const grader = parseGrader({ schema: 'paideia.grader.v1', id: 'g', golden: 'g.yaml', calibration: 'c.json',
    teachers: [{ id: 't', provider: 'claude', model: 'opus' }],
    models: [{ id: 'first', backend: 'jev-http', endpoint: 'http://localhost:8000', name: 'm1' },
      { id: 'second', backend: 'jev-http', endpoint: 'http://localhost:8001', name: 'm2' }],
    escalate: { to: 't', between: [0.3, 0.7] },
    questions: ['a', 'b'].map(id => ({ id, type: 'yes-no', expected: 'yes', reads: ['output.body'] })),
    score: { method: 'weighted', pass_at: 0.8 } });
  const makeBackend = (name: string, probability: number): DecisionBackend => ({
    identity: vi.fn(async () => ({ backend: 'fake', model: name })),
    score: vi.fn(async (requests: DecisionRequest[]) => requests.map(request => ({ key: request.key,
      status: 'ok' as const, probabilities: { yes: probability, no: 1 - probability } }))),
  });
  const backends = { first: makeBackend('m1', 0.9), second: makeBackend('m2', 0.8) };
  const modelIdentities = await decisionModelIdentities(grader, backends);
  const goldenDigest = stableDigest('golden');
  const calibration: GradeOptions['calibration'] = { schema: 'paideia.grader-calibration.v1',
    identity: createCalibrationIdentity(grader, { backendModel: stableDigest(modelIdentities), modelIdentities,
      golden: goldenDigest, promptTemplateVersion: 'v1', seed: 's', exclusions: [] }),
    questions: Object.fromEntries(['a', 'b'].map((id, i) => [id, { model: i ? 'second' : 'first',
      status: 'calibrated', failures: [], params: { a: 1, b: 0 }, band: [0.3, 0.7],
      metrics: { groups: 20, instances: 40, good: 20, bad: 20, baseRate: 0.5 } }])) };
  return { grader, calibration, backend: backends.first, backends, goldenDigest, promptTemplateVersion: 'v1',
    resource: {}, output: { body: ['Report.'] } };
}

it('routes each question to its selected backend and persists attribution without invented calls', async () => {
  const f = await fixture();
  const result = await gradeOutput(f);
  expect(result.score).toBeCloseTo(0.85);
  expect(result.status).toBe('pass');
  expect(result.decisions).toEqual([{ instance: 'a', model: 'first', status: 'ok' }, { instance: 'b', model: 'second', status: 'ok' }]);
  expect(result.judgeCalls).toEqual([]);
  expect(createGradeResultSchema(z.never()).parse(result)).toEqual(result);
  expect(f.backends!.first!.score).toHaveBeenCalledWith([expect.objectContaining({ key: 'a' })], undefined);
  expect(f.backends!.second!.score).toHaveBeenCalledWith([expect.objectContaining({ key: 'b' })], undefined);
});

it.each(['first', 'second'])('refuses changed referenced model %s before any scoring', async id => {
  const f = await fixture();
  f.backends![id]!.identity = async () => ({ backend: 'fake', model: 'changed' });
  await expect(gradeOutput(f)).rejects.toThrow('calibration identity mismatch');
  expect(f.backends!.first!.score).not.toHaveBeenCalled();
  expect(f.backends!.second!.score).not.toHaveBeenCalled();
});

it('refuses changed model list, unbound selections and absent backend routes', async () => {
  const f = await fixture();
  f.grader.models!.reverse();
  await expect(gradeOutput(f)).rejects.toThrow('mismatch: models');
  f.grader.models!.reverse();
  f.calibration.questions.b!.model = 'nonexistent';
  await expect(gradeOutput(f)).rejects.toThrow('Decision model nonexistent: missing backend');
  f.calibration.questions.b!.model = 'second';
  delete f.backends!.second;
  await expect(gradeOutput(f)).rejects.toThrow('Decision model second: missing backend');
  delete f.backends;
  await expect(gradeOutput(f)).rejects.toThrow('Decision model first: missing backend');
});

it('checks identity again after every selected backend has answered', async () => {
  const f = await fixture();
  vi.mocked(f.backends!.second!.identity).mockResolvedValueOnce({ backend: 'fake', model: 'm2' })
    .mockResolvedValue({ backend: 'fake', model: 'drift' });
  await expect(gradeOutput(f)).rejects.toThrow('Backend identity changed during grading');
});

it('records missing or omitted answers and refuses cross-model result keys', async () => {
  const f = await fixture();
  f.backends!.second!.score = async () => [];
  expect(await gradeOutput(f)).toMatchObject({ status: 'unknown', coverage: 0.5,
    decisions: [{ instance: 'a', model: 'first', status: 'ok' }, { instance: 'b', model: 'second', status: 'missing' }] });
  f.backends!.second!.score = async () => [{ key: 'a', status: 'missing', probabilities: null }];
  await expect(gradeOutput(f)).rejects.toThrow('Unexpected decision key: a');
});

it('uses a selected teacher directly while retaining local calibration and mixed billing', async () => {
  const f = await fixture();
  f.grader.models![1] = { id: 'second', backend: 'teacher', teacher: 't' };
  delete f.calibration.questions.b!.params;
  delete f.calibration.questions.b!.band;
  f.calibration.questions.b!.teacherAccuracy = { groups: 20, instances: 40, good: 20, bad: 20,
    agreement: 1, source: 'human', failures: [], warnings: [] };
  f.backends!.second!.score = async requests => requests.map(request => ({ key: request.key,
    status: 'ok', probabilities: { yes: 1, no: 0 } }));
  const modelIdentities = await decisionModelIdentities(f.grader, f.backends!);
  f.calibration.identity = createCalibrationIdentity(f.grader, { ...f.calibration.identity,
    backendModel: stableDigest(modelIdentities), modelIdentities });
  const result = await gradeOutput(f);
  expect(result.backendBilling).toBe('mixed');
  expect(result.score).toBeCloseTo(0.95);
  expect(result.questions[1]).toMatchObject({ id: 'b', score: 1, escalated: 0 });
});

it('probes supplied routes only and names a failing model identity', async () => {
  const f = await fixture();
  expect(await decisionModelIdentities(f.grader, { first: f.backend })).toEqual({
    first: f.calibration.identity.modelIdentities!.first });
  f.backends!.second!.identity = async () => { throw new Error('unavailable'); };
  await expect(decisionModelIdentities(f.grader, f.backends!)).rejects.toThrow('Decision model second: identity failed');
});
