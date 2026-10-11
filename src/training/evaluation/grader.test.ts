import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { CheckNode } from '../contracts/dataset.js';
import type { EvaluationContext, JudgeCall } from '../contracts/evaluation.js';
import type { DecisionBackend, DecisionRequest } from '../contracts/grading.js';
import { parseDatasetYaml, resolveDataset } from '../cases/index.js';
import { createCalibrationIdentity, decisionBackendIdentity, parseGrader, sha256, type GradingRuntime } from '../graders/index.js';
import { artifact, evaluationContext, snapshot, observation } from '../testing/index.js';
import { createEvaluationRegistry, evaluateNode, evaluatePlan } from './index.js';
import { evaluateGrader } from './grader.js';

async function fixture(gates: { id: string; check: CheckNode }[] = []) {
  const grader = parseGrader({ schema: 'paideia.grader.v1', id: 'writing', golden: 'golden.yaml', calibration: 'calibration.json',
    context: { evidence: { description: 'Evidence the author had' } },
    teachers: [{ id: 't', provider: 'claude', model: 'm' }],
    model: { backend: 'ollama-logprobs', endpoint: 'http://localhost:11434', name: 'm' },
    escalate: { to: 't', between: [0.4, 0.6] }, gates,
    questions: [{ id: 'q', type: 'yes-no', expected: 'yes', reads: ['output.body', 'context.evidence'] }], score: { method: 'weighted', pass_at: 0.7 } });
  const call: JudgeCall = { id: 'call', judge: 'local', providerId: 'ollama', requestedModel: 'm', responseModel: 'm', responseRoute: 'local',
    outcome: 'completed', usage: null, billing: 'local' };
  const backend: DecisionBackend = { identity: async () => ({ backend: 'ollama-logprobs', model: 'm', digest: 'model-digest' }),
    score: vi.fn(async (requests: DecisionRequest[]) => requests.map(request => ({ key: request.key, status: 'ok' as const, probabilities: { yes: 0.9, no: 0.1 }, judgeCalls: [call] }))) };
  const goldenDigest = 'a'.repeat(64);
  const identity = createCalibrationIdentity(grader, { backendModel: await decisionBackendIdentity(grader, backend),
    golden: goldenDigest, promptTemplateVersion: 'v1', seed: '', exclusions: [] });
  const calibration: GradingRuntime['calibration'] = { schema: 'paideia.grader-calibration.v1', identity,
    questions: { q: { status: 'calibrated', failures: [], params: { a: 1, b: 0 }, band: [0.4, 0.6],
      metrics: { groups: 20, instances: 40, good: 20, bad: 20, baseRate: 0.5 } } } };
  const files: Record<string, string> = { 'grader.yaml': stringify(grader), 'calibration.json': JSON.stringify(calibration) };
  const dataset = resolveDataset(parseDatasetYaml(stringify({ schema: 'paideia.dataset.v1', id: 'd',
    checks: [{ id: 'quality', eval: 'grader', grader: 'grader.yaml', input: 'artifact:article', context: { evidence: 'input:files' } }],
    records: [{ id: 'r', input: { prompt: 'Write' }, outputs: { article: 'article.json' } }],
  }), { sourceName: '/project/dataset.yaml' }), { readCriterionFile: name => files[name]!,
    registry: { evaluators: { 'project-gate': { version: '1', kind: 'mechanical', incremental: true, stopProof: true, validate() {} } } } });
  const runtime: GradingRuntime = { grader, calibration, backend, goldenDigest, promptTemplateVersion: 'v1', resource: {},
    definitionDigest: sha256(files['grader.yaml']!), calibrationDigest: sha256(files['calibration.json']!) };
  const context = evaluationContext({ graders: { '/project/grader.yaml': runtime } });
  return { context, runtime, backend, check: dataset.sharedStages[0]!.checks[0]!, stages: dataset.sharedStages };
}

describe('grader builtin evaluation', () => {
  it('runs the resolved evaluator through the engine, retaining probability, identity and judge cost calls', async () => {
    const { context, check, stages, backend } = await fixture();
    const result = await evaluatePlan(stages, context, createEvaluationRegistry());
    expect(result.status).toBe('pass');
    expect(result.checks.quality).toMatchObject({ grading: { coverage: 1, identity: { calibration: { promptTemplateVersion: 'v1' } } } });
    expect(result.checks.quality!.score).toBeCloseTo(0.9);
    expect(result.judgeCalls).toMatchObject([{ id: 'call', billing: 'local' }]);
    expect(vi.mocked(backend.score).mock.calls[0]![0][0]!.projection).toEqual({ 'output.body': ['A precise report.'], 'context.evidence': { packet: 'Source evidence' } });
    expect((await evaluateNode(check, { ...context, snapshot: snapshot({ closed: false }) }, createEvaluationRegistry())).finality).toBe('provisional');
  });
  it('keeps absent or unbound trial context unknown and does not score missing instances', async () => {
    const { context, check, backend } = await fixture();
    const absent = await evaluateNode({ ...check, context: { evidence: 'artifact:absent' } }, context, createEvaluationRegistry());
    expect(absent).toMatchObject({ status: 'unknown', grading: { coverage: 0 } });
    expect(backend.score).not.toHaveBeenCalled();
    expect((await evaluateNode({ ...check, context: {} }, context, createEvaluationRegistry())).status).toBe('unknown');
    expect((await evaluateNode({ ...check, context: undefined }, context, createEvaluationRegistry())).status).toBe('unknown');
    expect((await evaluateNode(check, { ...context, snapshot: snapshot({ artifacts: {} }) }, createEvaluationRegistry())).status).toBe('unknown');
    expect((await evaluateNode({ ...check, context: { unknown: 'input:files' } }, context, createEvaluationRegistry())).reason).toContain('Unknown grader context');
  });
  it('refuses absent runtimes and swapped definition/calibration identity before inference', async () => {
    const { context, check, runtime, backend } = await fixture();
    const registry = createEvaluationRegistry();
    expect((await evaluateNode(check, evaluationContext(), registry)).reason).toContain('Unresolved grader runtime');
    for (const field of ['definitionDigest', 'calibrationDigest'] as const) {
      expect((await evaluateNode(check, { ...context, graders: { '/project/grader.yaml': { ...runtime, [field]: 'changed' } } }, registry)).reason).toContain('identity');
    }
    const { grader_binding: _binding, ...unresolved } = check;
    expect((await evaluateNode({ ...unresolved, grader: 'grader.yaml' }, { ...context, graders: { 'grader.yaml': runtime } }, registry)).reason).toContain('identity');
    expect(backend.score).not.toHaveBeenCalled();
  });
  it('hard-fails failed gates, passes authentic artifact bytes to project gates and preserves gate calls', async () => {
    const { context, check, backend } = await fixture([{ id: 'valid', check: { eval: 'project-gate' } },
      { id: 'later', check: { eval: 'project-gate' } }]);
    let observed: EvaluationContext | undefined;
    const gateCall: JudgeCall = { id: 'gate-call', judge: 'gate', providerId: 'provider', requestedModel: 'm', responseModel: 'm',
      responseRoute: 'provider', outcome: 'completed', usage: { inputTokens: 2, cachedInputTokens: null, outputTokens: 1, reasoningTokens: null, source: 'reported' } };
    const registry = createEvaluationRegistry({ 'project-gate': { definition: { version: '1', kind: 'mechanical', incremental: true, stopProof: true, validate() {} },
      async evaluate(_check, local) { observed = local; return { status: 'fail', finality: 'final', reason: 'Rejected',
        evidence: [{ kind: 'event', id: 'gate-receipt' }], judgeCalls: [gateCall] }; } } });
    const originalScore = vi.mocked(backend.score).getMockImplementation()!;
    vi.mocked(backend.score).mockRejectedValue(new Error('HTTP 503'));
    const identityProbe = vi.spyOn(backend, 'identity').mockRejectedValue(new Error('Identity HTTP 503'));
    const result = await evaluateNode(check, context, registry);
    expect(result).toMatchObject({ status: 'fail', score: 0, grading: { gates: [{ id: 'valid', status: 'fail' }, { id: 'later', status: 'unknown' }] } });
    expect(result.children).toHaveLength(1);
    expect(result.evidence).toContainEqual({ kind: 'event', id: 'gate-receipt' });
    expect(result.judgeCalls).toEqual([gateCall]);
    expect(backend.score).not.toHaveBeenCalled();
    expect(identityProbe).not.toHaveBeenCalled();
    expect(result.usage).toEqual([gateCall.usage]);
    expect(observed!.gradedArtifact).toEqual(artifact());
    expect(observed!.snapshot).toEqual(context.snapshot);
    expect(registry.grader!.concurrency!(check, context)).toBeUndefined();
    await expect(evaluateGrader(check, context)).rejects.toThrow('evaluation engine');
    vi.mocked(backend.score).mockImplementation(originalScore);
    identityProbe.mockRestore();
    expect((await evaluateGrader(check, { ...context, evaluateCheck: async () => ({ status: 'skipped', finality: 'final', reason: 'skipped', evidence: [] }) })).status).toBe('unknown');
    expect(backend.score).toHaveBeenCalledTimes(1);
  });
  it('requires validated bytes at resolution and rejects mismatched filing through evaluation', async () => {
    const sequence = (cel: string) => ({ id: 'bound', check: { eval: 'tool-sequence', order: 'happens-before',
      ending_at: { artifact: 'article', event: 'accepted-call' },
      steps: [{ tool: 'validate', bind: { article: 'call.args.article' } }, { tool: 'file', where: { cel } }] } });
    for (const cel of ['bindings.article != null', 'call.args.article == bindings.article || true']) {
      await expect(fixture([sequence(cel)])).rejects.toThrow('must require argument equality');
    }
    const { context, check, backend } = await fixture([sequence('call.args.article == bindings.article')]);
    const events = (filed: string) => [
      observation({ id: 'validated', callId: 'validation', tool: 'validate', seq: 1, args: { article: 'SAFE' } }),
      observation({ id: 'validated-result', callId: 'validation', tool: 'validate', seq: 2, type: 'tool.complete', success: true }),
      observation({ id: 'filed', callId: 'file', tool: 'file', seq: 3, args: { article: filed } }),
      observation({ id: 'filed-result', callId: 'file', tool: 'file', seq: 4, type: 'tool.complete', success: true }),
    ];
    const registry = createEvaluationRegistry();
    const failed = await evaluateNode(check, { ...context, snapshot: snapshot({ events: events('UNVALIDATED') }) }, registry);
    expect(failed).toMatchObject({ status: 'fail', score: 0, children: [{ id: 'bound', status: 'fail' }] });
    expect(backend.score).not.toHaveBeenCalled();
    expect((await evaluateNode(check, { ...context, snapshot: snapshot({ events: events('SAFE') }) }, registry)).status).toBe('pass');
  });
  it('serializes shared backend resources and includes nested resource declarations', async () => {
    const { context, check, runtime } = await fixture([{ id: 'gate', check: { any: [{ not: { eval: 'equals', input: 'artifact:article', value: 'wrong' } }] } }]);
    const registry = createEvaluationRegistry();
    expect(registry.grader!.concurrency!(check, context)).toEqual([runtime.resource]);
    expect(registry.grader!.concurrency!({ ...check, grader: 'absent', grader_binding: undefined }, context)).toEqual([]);
    expect(registry.grader!.concurrency!({ ...check, grader_binding: { gates: [{ check: { passed: 'sibling' } }] } }, context)).toBeUndefined();
    let active = 0; let maximum = 0;
    vi.mocked(runtime.backend.score).mockImplementation(async requests => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5)); active--;
      return requests.map(request => ({ key: request.key, status: 'ok' as const, probabilities: { yes: 0.9, no: 0.1 } }));
    });
    const result = await evaluatePlan([{ id: 's', checks: [{ ...check, id: 'a' }, { ...check, id: 'b' }] }], context, registry);
    expect(result.status).toBe('pass'); expect(maximum).toBe(1);
  });
});
