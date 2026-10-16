import { expect, it, vi } from 'vitest';
import type { DecisionBackend, DecisionRequest } from '../contracts/grading.js';
import { parseGrader } from './format/index.js';
import { checkCalibration } from './identity.js';
import { createIdentityCalibration } from './identity-calibration.js';
import { decisionBackendIdentity, gradeOutput } from './runtime/index.js';

const authored = { schema: 'paideia.grader.v1', id: 'fixed', calibration: 'identity',
  model: { backend: 'typesafe', name: 'jev-1.13.0' }, max_spend_usd: 0.5,
  context: { grounding: { description: 'Frozen human facts' } },
  questions: [
    { id: 'q1', ask: 'Does the text state ten?', type: 'yes-no', expected: 'yes', reads: ['output.body', 'context.grounding'], weight: 2 },
    { id: 'q2', ask: 'Does it claim twenty?', type: 'yes-no', expected: 'no', reads: ['output.body', 'context.grounding'], weight: 1 },
  ], score: { method: 'weighted', pass_at: 0.7 } };
async function fixture(p = 0.8) {
  const grader = parseGrader(authored);
  const backend: DecisionBackend = { identity: async () => ({ backend: 'typesafe', model: 'jev-1.13.0' }),
    score: vi.fn(async (requests: DecisionRequest[]) => requests.map(request => ({ key: request.key, status: 'ok' as const, probabilities: { yes: p, no: 1 - p } }))) };
  const calibration = createIdentityCalibration(grader, await decisionBackendIdentity(grader, backend), 'v1');
  return { grader, backend, calibration, goldenDigest: calibration.identity.golden, promptTemplateVersion: 'v1', resource: {},
    output: { body: ['Ten items.'] }, context: { grounding: 'There are ten items.' } };
}
it('preserves raw endpoints and weighted P(expected), with explicit uncalibrated identity and no teacher', async () => {
  const f = await fixture();
  const result = await gradeOutput(f);
  expect(result.score).toBeCloseTo(0.6); expect(result.status).toBe('fail');
  expect(result.identity.calibration.mode).toBe('identity');
  expect(f.calibration.questions.q1).toMatchObject({ status: 'uncalibrated', metrics: { groups: 0 } });
  expect(result.questions.map(q => q.escalated)).toEqual([0, 0]);
  for (const p of [0, 0.5, 1]) {
    const single = await fixture(p); single.grader.questions = [single.grader.questions[0]!];
    single.calibration = createIdentityCalibration(single.grader, await decisionBackendIdentity(single.grader, single.backend), 'v1');
    expect((await gradeOutput(single)).score).toBe(p);
  }
});
it('keeps missing answers/context in the denominator and never passes incomplete scoring', async () => {
  const f = await fixture();
  f.backend.score = async requests => [{ key: requests[0]!.key, status: 'ok', probabilities: { yes: 1, no: 0 } }];
  expect(await gradeOutput(f)).toMatchObject({ status: 'unknown', coverage: 0.5, score: 2 / 3 });
  f.backend.score = async () => [];
  expect(await gradeOutput(f)).toMatchObject({ status: 'unknown', score: 0 });
  expect(await gradeOutput({ ...f, context: {} })).toMatchObject({ status: 'unknown', coverage: 0 });
});
it.each([
  { yes: 0.8 }, { yes: 0.8, no: 0.1 }, { yes: NaN, no: 0.2 }, { yes: -0.1, no: 1.1 },
  { yes: 0.8, no: 0.2, extra: 0 }, { yes: 2, no: -1 },
] as Record<string, number>[])('rejects invalid decision shape and values %j', async probabilities => {
  const f = await fixture(); f.backend.score = async requests => requests.map(r => ({ key: r.key, status: 'ok', probabilities }));
  await expect(gradeOutput(f)).rejects.toThrow('Invalid decision probabilities');
});
it('rejects unexpected/duplicate result keys and backend identity drift', async () => {
  const f = await fixture();
  f.backend.score = async () => [{ key: 'unrequested', status: 'missing', probabilities: null }];
  await expect(gradeOutput(f)).rejects.toThrow('Unexpected decision key');
  f.backend.score = async () => [{ key: 'q1', status: 'missing', probabilities: null }, { key: 'q1', status: 'missing', probabilities: null }];
  await expect(gradeOutput(f)).rejects.toThrow('Unexpected decision key');
  f.backend.identity = async () => ({ backend: 'typesafe', model: 'changed' });
  await expect(gradeOutput(f)).rejects.toThrow('identity mismatch');
});
it('requires explicit mode and pins it against calibrated reuse', async () => {
  const f = await fixture();
  delete f.calibration.identity.mode;
  expect(checkCalibration(f.grader, f.calibration, f.calibration.identity).ok).toBe(false);
  await expect(gradeOutput(f)).rejects.toThrow('identity mismatch: mode');
  expect(() => createIdentityCalibration({ ...f.grader, calibration: 'calibration.json' }, 'backend', 'v1')).toThrow('explicitly authored');
  f.calibration.identity.mode = 'identity';
  expect(checkCalibration({ ...f.grader, calibration: 'calibration.json', teachers: [{ id: 'none', provider: 'codex', model: 'm' }] }, f.calibration, f.calibration.identity).refusals).toContain('calibration mode mismatch');
});
it.each([
  { golden: 'labels.yaml' }, { golden: { schema: 'paideia.labels.v1', labelers: {}, labels: [{ id: 'invalid' }] } },
  { max_spend_usd: undefined }, { teachers: [{ id: 't', provider: 'codex', model: 'm' }] },
  { model: { backend: 'teacher', teacher: 't' } }, { escalate: { to: 't', between: [0.4, 0.6] } },
  { uncalibrated: 'teacher' }, { model: undefined, models: [{ id: 'a', backend: 'typesafe', name: 'jev-1.13.0' }] },
])('rejects unsupported identity configuration %j', change => {
  expect(() => parseGrader({ ...authored, ...change })).toThrow();
});
