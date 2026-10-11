import { expect, it, vi } from 'vitest';
import type { DecisionBackend, DecisionRequest } from '../../contracts/grading.js';
import type { InferenceProvider } from '../../contracts/execution.js';
import { parseGrader, stableDigest } from '../format/index.js';
import { createCalibrationIdentity, type CalibrationFile } from '../identity.js';
import { gradeOutput, decisionBackendIdentity, type GradeOptions } from './index.js';

async function fixture(p = 0.9): Promise<GradeOptions> {
  const grader = parseGrader({ schema: 'paideia.grader.v1', id: 'g', golden: 'g.yaml', calibration: 'c.json',
    context: { evidence: { description: 'Trial evidence' } },
    teachers: [{ id: 'c', provider: 'claude', model: 'opus' }],
    model: { backend: 'jev-http', endpoint: 'http://localhost:8000', name: 'm' },
    escalate: { to: 'c', between: [0.3, 0.7], max_calls_per_trial: 1 },
    questions: [{ id: 'q', type: 'yes-no', expected: 'yes', reads: ['output.body', 'context.evidence'] }],
    score: { method: 'weighted', pass_at: 0.75 } });
  const backend: DecisionBackend = { identity: vi.fn(async () => ({ backend: 'fake', model: 'm' })),
    score: vi.fn(async (requests: DecisionRequest[]) => requests.map(request => ({ key: request.key, status: 'ok' as const, probabilities: { yes: p, no: 1 - p } }))) };
  const provider: InferenceProvider = { id: 'claude-subscription', capabilities: {
    billing: 'subscription', tools: 'disabled', temperature: false, seed: false },
    generate: vi.fn(async request => ({ text: JSON.stringify(Object.fromEntries(
      (JSON.parse(request.prompt) as { questions: { key: string }[] }).questions.map(q => [q.key, 'yes']))),
    model: 'actual-opus', route: 'subscription', usage: null })) };
  const goldenDigest = stableDigest('golden'), promptTemplateVersion = 'v1';
  const calibration: CalibrationFile = { schema: 'paideia.grader-calibration.v1', identity: createCalibrationIdentity(grader,
    { backendModel: await decisionBackendIdentity(grader, backend), golden: goldenDigest, promptTemplateVersion, seed: '0', exclusions: [] }),
  questions: { q: { status: 'calibrated', failures: [], params: { a: 1, b: 0 }, band: [0.3, 0.7],
    metrics: { groups: 20, instances: 40, good: 20, bad: 20, baseRate: 0.5 } } } };
  return { grader, calibration, backend, teacher: { provider, model: 'opus' }, goldenDigest, promptTemplateVersion,
    resource: {}, output: { body: ['Report.'] }, context: { evidence: 'Source.' } };
}
async function reidentify(f: GradeOptions) {
  f.calibration.identity = createCalibrationIdentity(f.grader, { ...f.calibration.identity,
    backendModel: await decisionBackendIdentity(f.grader, f.backend) });
}
it('applies Platt scaling, passes outside band and pins result policy digests', async () => {
  const f = await fixture();
  f.calibration.questions.q!.params = { a: 1, b: 1 };
  const result = await gradeOutput(f);
  expect(result.status).toBe('pass');
  expect(result.score).toBeGreaterThan(0.9);
  expect(result.identity.calibration).toEqual(f.calibration.identity);
  expect(result.identity.escalation).toBe(stableDigest(f.grader.escalate));
  expect(result.identity.teacherPolicy).toHaveLength(64);
  expect(result.identity.scoringPolicy).toHaveLength(64);
  expect(f.teacher!.provider.generate).not.toHaveBeenCalled();
  expect(f.backend.score).toHaveBeenCalledWith([expect.objectContaining({ key: 'q', expectedOptions: ['yes'] })], undefined);
});
it.each(['backendModel', 'golden', 'promptTemplateVersion', 'segmenter', 'questions', 'optionMapping'] as const)(
  'refuses changed calibration identity %s before scoring', async component => {
    const f = await fixture();
    if (component === 'questions' || component === 'optionMapping') f.calibration.identity[component].q = stableDigest('changed');
    else f.calibration.identity[component] = stableDigest('changed');
    await expect(gradeOutput(f)).rejects.toThrow(`mismatch: ${component}`);
    expect(f.backend.score).not.toHaveBeenCalled();
  });
it('refuses uncalibrated questions or always routes them to teacher', async () => {
  const f = await fixture();
  f.calibration.questions.q!.status = 'unverified';
  f.calibration.questions.q!.failures = ['independent groups'];
  await expect(gradeOutput(f)).rejects.toThrow('question q: independent groups');
  f.grader.uncalibrated = 'teacher';
  await reidentify(f);
  const result = await gradeOutput(f);
  expect(result).toMatchObject({ status: 'pass', score: 1, questions: [{ escalated: 1 }] });
  expect(f.backend.score).not.toHaveBeenCalled();
});
it.each([0.3, 0.5, 0.7])('routes calibrated band including boundary %s', async p => {
  const f = await fixture(p);
  // Use exact identity scaling boundary to avoid logit roundoff at 0.3.
  const transformed = (await import('../calibration/index.js')).applyPlatt(p, { a: 1, b: 0 });
  f.calibration.questions.q!.band = [transformed, 0.99];
  const result = await gradeOutput(f);
  expect(result).toMatchObject({ status: 'pass', score: 1, questions: [{ escalated: 1 }] });
  expect(result.judgeCalls).toEqual([expect.objectContaining({ providerId: 'claude-subscription', requestedModel: 'opus',
    responseModel: 'actual-opus', outcome: 'completed', billing: 'subscription', wallMs: expect.any(Number) })]);
});
it('batches identical projections and caps distinct projections with missing overflow', async () => {
  const f = await fixture(0.5);
  f.grader.questions.push({ ...f.grader.questions[0]!, id: 'same' }, { ...f.grader.questions[0]!, id: 'different', reads: ['context.evidence'] });
  for (const q of ['same', 'different']) f.calibration.questions[q] = structuredClone(f.calibration.questions.q!);
  await reidentify(f);
  const result = await gradeOutput(f);
  expect(result).toMatchObject({ status: 'unknown', score: 2 / 3, coverage: 2 / 3 });
  expect(result.questions.map(q => q.missing)).toEqual([0, 0, 1]);
  expect(f.teacher!.provider.generate).toHaveBeenCalledTimes(1);
  const prompt = JSON.parse(vi.mocked(f.teacher!.provider.generate).mock.calls[0]![0].prompt) as { questions: { key: string }[] };
  expect(prompt.questions.map(q => q.key)).toEqual(['q', 'same']);
});
it('missing trial context stays unknown without inference', async () => {
  const f = await fixture();
  delete f.context!.evidence;
  const result = await gradeOutput(f);
  expect(result).toMatchObject({ status: 'unknown', coverage: 0, score: 0, questions: [{ missing: 1 }] });
  expect(f.backend.score).not.toHaveBeenCalled();
  expect(f.teacher!.provider.generate).not.toHaveBeenCalled();
});
it.each(['abstain', 'no', 'invalid', 'failure', 'no-route'] as const)('handles teacher %s without optimism', async mode => {
  const f = await fixture(0.5);
  if (mode === 'no-route') delete f.teacher;
  else f.teacher!.provider.generate = async () => {
    if (mode === 'failure') throw Error('provider unavailable');
    return { text: mode === 'invalid' ? '{}' : JSON.stringify({ q: mode }), model: 'actual', route: 'test', usage: null };
  };
  const result = await gradeOutput(f);
  expect(result.status).toBe(mode === 'no' ? 'fail' : 'unknown');
  expect(result.score).toBe(0);
  if (mode === 'failure') expect(result.judgeCalls[0]!.outcome).toBe('generation-error');
  if (mode === 'invalid') expect(result.judgeCalls[0]!.outcome).toBe('invalid-response');
});
it('failed check gates force score zero and unknown gates never pass', async () => {
  const f = await fixture();
  f.grader.gates = [{ id: 'gate', check: { eval: 'project/check' } }];
  expect(await gradeOutput({ ...f, gateOutcomes: { gate: 'fail' } })).toMatchObject({ status: 'fail', score: 0 });
  expect(await gradeOutput(f)).toMatchObject({ status: 'unknown' });
});
it('gate questions require calibration and threshold their final answer', async () => {
  const f = await fixture(0.5);
  f.grader.gates = [{ ...f.grader.questions[0]!, id: 'gate', level: 'article' }];
  f.calibration.questions.gate = structuredClone(f.calibration.questions.q!);
  await reidentify(f);
  f.teacher!.provider.generate = async () => ({ text: '{"q":"yes","gate":"no"}', model: 'm', route: 'r', usage: null });
  expect(await gradeOutput(f)).toMatchObject({ status: 'fail', score: 0, gates: [{ id: 'gate', status: 'fail' }] });
  delete f.calibration.questions.gate;
  await expect(gradeOutput(f)).rejects.toThrow('question gate');
});
it('refuses incomplete calibration, invalid probability mass, unexpected keys and model drift', async () => {
  const f = await fixture();
  delete f.calibration.questions.q!.params;
  await expect(gradeOutput(f)).rejects.toThrow('Platt');
  f.calibration.questions.q!.params = { a: 1, b: 0 };
  f.backend.score = async () => [{ key: 'q', status: 'ok', probabilities: { yes: 0.9, no: 0.9 } }];
  await expect(gradeOutput(f)).rejects.toThrow('probabilities');
  f.backend.score = async () => [{ key: 'bad', status: 'missing', probabilities: null }];
  await expect(gradeOutput(f)).rejects.toThrow('Unexpected decision key');
  f.backend.score = async () => [{ key: 'q', status: 'missing', probabilities: null }];
  expect(await gradeOutput(f)).toMatchObject({ status: 'unknown' });
  vi.mocked(f.backend.identity).mockResolvedValueOnce({ backend: 'fake', model: 'm' }).mockResolvedValue({ backend: 'fake', model: 'drift' });
  await expect(gradeOutput(f)).rejects.toThrow('changed during grading');
});
it('rejects wrong teacher policy and non-subscription routes', async () => {
  const f = await fixture(0.5);
  f.teacher!.model = 'other';
  await expect(gradeOutput(f)).rejects.toThrow('declared policy');
  f.teacher!.model = 'opus';
  f.teacher!.provider.capabilities.billing = 'api';
  await expect(gradeOutput(f)).rejects.toThrow('tool-free subscription');
});
it('preserves backend teacher calls and uses one-hot scores without Platt', async () => {
  const f = await fixture(1);
  f.grader.model = { backend: 'teacher', teacher: 'c' };
  delete f.calibration.questions.q!.params;
  delete f.calibration.questions.q!.band;
  await reidentify(f);
  expect(await gradeOutput(f)).toMatchObject({ status: 'pass', score: 1 });
});
it('honors cancellation before inference and during teacher failure', async () => {
  const f = await fixture(0.5), controller = new AbortController();
  controller.abort(Error('cancelled'));
  await expect(gradeOutput({ ...f, signal: controller.signal })).rejects.toThrow('cancelled');
  const running = new AbortController();
  f.teacher!.provider.generate = async () => { running.abort(Error('cancelled')); throw Error('provider'); };
  await expect(gradeOutput({ ...f, signal: running.signal })).rejects.toThrow('cancelled');
});
it('does not claim requested model assumptions and retains measured failure provenance', async () => {
  const f = await fixture(0.5);
  f.teacher!.provider.generate = async () => ({ text: '{"q":"yes"}', model: 'opus', modelBasis: 'requested-assumption', route: 'r', usage: null });
  expect((await gradeOutput(f)).judgeCalls[0]!.responseModel).toBeNull();
  const usage = { inputTokens: 10, outputTokens: 2, cachedInputTokens: null, reasoningTokens: null, source: 'measured' };
  f.teacher!.provider.generate = async () => { throw Object.assign(Error('quota'), { usage, responseModel: 'actual', responseRoute: 'r' }); };
  expect((await gradeOutput(f)).judgeCalls[0]).toMatchObject({ usage, responseModel: 'actual', responseRoute: 'r' });
  f.teacher!.provider.generate = async () => { throw null; };
  expect((await gradeOutput(f)).judgeCalls[0]!.usage).toBeNull();
});

it.each([false, true])('admits the first requested escalation, skipping earlier local projections (forced=%s)', async forced => {
  const f = await fixture(0.5);
  f.grader.questions.push({ ...f.grader.questions[0]!, id: 'b', reads: ['context.evidence'] },
    { ...f.grader.questions[0]!, id: 'a' });
  for (const id of ['b', 'a']) f.calibration.questions[id] = structuredClone(f.calibration.questions.q!);
  f.backend.score = vi.fn(async (requests: DecisionRequest[]) => requests.map(request => ({ key: request.key, status: 'ok' as const,
    probabilities: request.key === 'q' ? { yes: 0.9, no: 0.1 } : { yes: 0.5, no: 0.5 } })));
  if (forced) {
    f.grader.uncalibrated = 'teacher';
    f.calibration.questions.a!.status = 'uncalibrated';
  }
  await reidentify(f);
  const result = await gradeOutput(f);
  const prompt = JSON.parse(vi.mocked(f.teacher!.provider.generate).mock.calls[0]![0].prompt) as { questions: { key: string }[] };
  expect(prompt.questions.map(q => q.key)).toEqual(['b']);
  expect(result.questions.map(q => q.missing)).toEqual([0, 0, 1]);
});
it('short-circuits a decisive failed mechanical gate before backend identity or teacher calls', async () => {
  const f = await fixture(0.5);
  f.grader.gates = [{ id: 'hard', check: { eval: 'project/check' } }];
  vi.mocked(f.backend.identity).mockClear().mockRejectedValue(Error('HTTP 503'));
  expect(await gradeOutput({ ...f, gateOutcomes: { hard: 'fail' } })).toMatchObject({
    status: 'fail', score: 0, gates: [{ id: 'hard', status: 'fail' }], judgeCalls: [] });
  expect(f.backend.identity).not.toHaveBeenCalled();
  expect(f.backend.score).not.toHaveBeenCalled();
  expect(f.teacher!.provider.generate).not.toHaveBeenCalled();
});

it('orders mixed forced and calibrated instances in a shared teacher prompt by expansion order', async () => {
  const f = await fixture(0.5);
  f.grader.questions.push({ ...f.grader.questions[0]!, id: 'forced' });
  f.grader.uncalibrated = 'teacher';
  f.calibration.questions.forced = { ...structuredClone(f.calibration.questions.q!), status: 'uncalibrated' };
  await reidentify(f);
  const result = await gradeOutput(f);
  const prompt = JSON.parse(vi.mocked(f.teacher!.provider.generate).mock.calls[0]![0].prompt) as { questions: { key: string }[] };
  expect(prompt.questions.map(q => q.key)).toEqual(['q', 'forced']);
  expect(result).toMatchObject({ status: 'pass', coverage: 1 });
});
