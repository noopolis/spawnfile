import { describe, expect, it, vi } from 'vitest';
import type { InferenceProvider } from '../../contracts/execution.js';
import type { EvaluationMeasurement, JudgeCache, JudgeFailureCause } from '../../contracts/evaluation.js';
import { judgeFailureCauses } from '../../contracts/evaluation.js';
import { createEvaluationRegistry, evaluateNode, evaluatePlan } from '../index.js';
import { inferenceJudgeCause, judgeFailure, thrownJudgeCause } from './failure.js';
import { artifact, evaluationContext, snapshot } from '../../testing/index.js';

const registry = createEvaluationRegistry();
const check = { id: 'grounding', eval: 'llm-rubric', input: 'artifact:article#/body',
  judge: 'grounding', rubric: { prompt: 'Grade grounding.' }, minimum: 0.8 };
const good = { score: 0.9, verdict: 'pass', reasons: ['Grounded.'], citations: [{ source: 'input', quote: 'precise' }] };

/**
 * A provider failure as the transport actually hands one over: typed discriminators
 * on the error, and prose in the message. Nothing here is an `instanceof` of an
 * inference implementation, because the evaluator must classify from the contract.
 */
function thrown(kind: string, extra: Record<string, unknown> = {}, message = 'provider blew up'): Error {
  return Object.assign(new Error(message), { kind, ...extra });
}
function provider(behaviour: () => Promise<{ text: string }> | never): InferenceProvider {
  return { id: 'grok-broker-grant',
    capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
    generate: vi.fn(async () => ({ model: 'grok-4.6', route: 'grok-broker-grant', usage: null, ...await behaviour() })) };
}
const answering = (text: string) => provider(async () => ({ text }));
const refusing = (error: Error) => provider(() => { throw error; });

async function judged(route: InferenceProvider, overrides: Record<string, unknown> = {}, node: Record<string, unknown> = {}) {
  const context = evaluationContext({ judges: { grounding: { provider: route, model: 'grok-4.6', ...overrides } } });
  return evaluateNode({ ...check, ...node }, context, registry);
}

describe('a judge that fails names its own cause', () => {
  it('publishes one closed-vocabulary cause for every way a judge can fail', async () => {
    const observed: [JudgeFailureCause, Awaited<ReturnType<typeof judged>>][] = [];
    const record = async (expected: JudgeFailureCause, evaluated: Awaited<ReturnType<typeof judged>>) => {
      observed.push([expected, evaluated]);
    };
    // A broker that will not lend a grant, and one whose grant or realm is gone.
    await record('grant-refused', await judged(refusing(thrown('unavailable', { detail: 'grant-refused' }))));
    await record('grant-expired', await judged(refusing(thrown('unavailable', { detail: 'grant-expired' }))));
    await record('grant-expired', await judged(refusing(thrown('auth-stale'))));
    // The provider's own refusal, with the status it reported.
    await record('provider-error', await judged(refusing(thrown('quota', { detail: 'provider-status', status: 429 }))));
    await record('provider-error', await judged(refusing(thrown('protocol'))));
    // An answer that arrived and could not be used.
    await record('response-unparseable', await judged(answering('not json at all')));
    await record('response-schema', await judged(answering(JSON.stringify({ score: 1 }))));
    await record('response-schema', await judged(refusing(thrown('invalid-response'))));
    await record('response-citations', await judged(answering(JSON.stringify({ ...good,
      citations: [{ source: 'input', quote: 'a quote nobody wrote' }] }))));
    // Boundaries the judge never got past.
    await record('timeout', await judged(refusing(thrown('timeout'))));
    await record('cancelled', await judged(refusing(thrown('cancelled'))));
    await record('unclassified', await judged(refusing(new Error('no discriminator at all'))));

    for (const [expected, evaluated] of observed) {
      expect(evaluated.status).toBe('error');
      expect(evaluated.judgeFailure?.cause, `${expected} must publish its own cause`).toBe(expected);
      expect(evaluated.judgeFailure?.judge).toBe('grounding');
      expect(evaluated.judgeFailure?.requestedModel).toBe('grok-4.6');
    }
    // Every recorded cause is a declared vocabulary member, and they are distinct.
    expect(new Set(observed.map(([cause]) => cause)).size).toBe(9);
    expect(observed.every(([, value]) => judgeFailureCauses.includes(value.judgeFailure!.cause))).toBe(true);
  });

  it('names the provider and route that answered, and a reported status', async () => {
    const refused = await judged(refusing(thrown('quota', { detail: 'provider-status', status: 429,
      responseModel: 'grok-4.6', responseRoute: 'grok-broker-grant' })));
    expect(refused.judgeFailure).toEqual({ cause: 'provider-error', judge: 'grounding', kind: 'quota',
      providerId: 'grok-broker-grant', requestedModel: 'grok-4.6',
      responseModel: 'grok-4.6', responseRoute: 'grok-broker-grant', status: 429 });
    // No status reported is not status zero: the field is simply absent.
    const silent = await judged(refusing(thrown('unavailable', { detail: 'grant-refused' })));
    expect(silent.judgeFailure).not.toHaveProperty('status');
    expect(Object.hasOwn(silent.judgeFailure!, 'kind')).toBe(true);
    // A nonsense status is not a status.
    const invalid = await judged(refusing(thrown('quota', { detail: 'provider-status', status: 1.5 })));
    expect(invalid.judgeFailure).not.toHaveProperty('status');
  });

  it('names causes that stopped the judge before and after any model was asked', async () => {
    const unconfigured = await evaluateNode(check, evaluationContext(), registry);
    expect(unconfigured.judgeFailure).toEqual({ cause: 'route-unusable', judge: 'grounding',
      providerId: null, requestedModel: null, responseModel: null, responseRoute: null });
    for (const route of [{ citationRepairs: 7 }, { protocol: 'runes' }, { protocol: 'evidence-ids', citationRepairs: 1 },
      { cache: emptyCache(), identity: undefined }, { cache: { ...emptyCache(), persistent: true }, identity: 'frozen' },
      { template: { language: 'jinja', text: '{% not a template' } }]) {
      const evaluated = await judged(answering(JSON.stringify(good)), route);
      expect(evaluated.judgeFailure?.cause, JSON.stringify(route)).toBe('route-unusable');
    }
    // Evidence the judge could not even be handed.
    const oversized = evaluationContext({ snapshot: snapshot({ artifacts: { article: artifact({ body: Array.from({ length: 400 }, (_, index) => index) }) } }),
      judges: { grounding: { provider: answering(JSON.stringify(good)), model: 'grok-4.6', protocol: 'evidence-ids' } } });
    expect((await evaluateNode(check, oversized, registry)).judgeFailure?.cause).toBe('evidence-unusable');
    // A persisted judgment that cannot be read back as one.
    const poisoned: JudgeCache = { get: async () => ({ response: 'not json', sourceCallId: 'call' }), put: async () => undefined };
    expect((await judged(answering(JSON.stringify(good)), { cache: poisoned, identity: 'frozen' })).judgeFailure?.cause).toBe('cache-unusable');
    // An attempt that could not be recorded may not be quietly accepted either.
    const context = evaluationContext({ judges: { grounding: { provider: answering(JSON.stringify(good)), model: 'grok-4.6' } },
      observeJudgeAttempt: () => { throw new Error('sink is down'); } });
    expect((await evaluateNode(check, context, registry)).judgeFailure?.cause).toBe('evidence-unpersisted');
    // A trial cancelled while the judge was in flight is its own cause, not a provider failure.
    const controller = new AbortController();
    const interrupted = provider(async () => { controller.abort(); return { text: JSON.stringify(good) }; });
    const cancelled = evaluationContext({ signal: controller.signal,
      judges: { grounding: { provider: interrupted, model: 'grok-4.6' } } });
    expect((await evaluateNode(check, cancelled, registry)).judgeFailure?.cause).toBe('cancelled');
  });

  it('classifies thrown rubric I/O through evaluateNode before any generation', async () => {
    const route = answering(JSON.stringify(good));
    const context = evaluationContext({ readText: async () => { throw new Error('unreadable rubric'); },
      judges: { grounding: { provider: route, model: 'grok-4.6' } } });
    const evaluated = await evaluateNode({ ...check, rubric: { file: 'rubric.md' } }, context, registry);
    expect(evaluated.status).toBe('error');
    expect(evaluated.judgeFailure).toMatchObject({ cause: 'route-unusable', judge: 'grounding', requestedModel: 'grok-4.6' });
    expect(route.generate).not.toHaveBeenCalled();
  });

  it.each(['get', 'put'] as const)('classifies thrown cache %s I/O through evaluateNode', async operation => {
    const route = answering(JSON.stringify(good));
    const cache = emptyCache();
    cache[operation] = async () => { throw new Error('cache I/O failed'); };
    const evaluated = await judged(route, { cache, identity: 'frozen' });
    expect(evaluated.status).toBe('error');
    expect(evaluated.judgeFailure?.cause).toBe('cache-unusable');
    expect(route.generate).toHaveBeenCalledTimes(operation === 'get' ? 0 : 1);
    expect(evaluated.judgeCalls).toHaveLength(operation === 'get' ? 0 : 1);
  });

  it('keeps absence an absence: a judge that never ran reports no failure', async () => {
    const missing = evaluationContext({ snapshot: snapshot({ artifacts: {} }),
      judges: { grounding: { provider: answering(JSON.stringify(good)), model: 'grok-4.6' } } });
    const unobserved = await evaluateNode(check, missing, registry);
    expect(unobserved.status).toBe('unknown');
    expect(unobserved.judgeFailure).toBeUndefined();
    const withoutEvidence = await evaluateNode({ ...check, evidence: 'artifact:absent' },
      evaluationContext({ judges: { grounding: { provider: answering(JSON.stringify(good)), model: 'grok-4.6' } } }), registry);
    expect(withoutEvidence.status).toBe('unknown');
    expect(withoutEvidence.judgeFailure).toBeUndefined();
  });

  it('leaves a healthy judge and its score exactly as they were', async () => {
    const route = answering(JSON.stringify(good));
    const evaluated = await judged(route);
    expect(evaluated.status).toBe('pass');
    expect(evaluated.score).toBe(0.9);
    expect(evaluated).not.toHaveProperty('judgeFailure');
    expect(evaluated.judgeCalls).toEqual([{ id: expect.any(String), judge: 'grounding', citationRepairs: 0,
      providerId: 'grok-broker-grant', requestedModel: 'grok-4.6', responseModel: 'grok-4.6',
      responseRoute: 'grok-broker-grant', outcome: 'completed', usage: null }]);
    const failing = await judged(answering(JSON.stringify({ ...good, verdict: 'fail', score: 0.2 })));
    expect(failing.status).toBe('fail');
    expect(failing).not.toHaveProperty('judgeFailure');
  });
});

describe('a named judge failure still costs its weight', () => {
  const stage = [{ id: 'writing', checks: [check, { id: 'prose', eval: 'llm-rubric', input: 'artifact:article#/body',
    judge: 'prose', rubric: { prompt: 'Grade prose.' }, minimum: 0.5 }],
  score: { linear: { grounding: 52, prose: 48 } } }];

  it('publishes the cause on the persisted measurement without shrinking the denominator', async () => {
    const measurements: EvaluationMeasurement[] = [];
    const context = evaluationContext({ observeMeasurement: value => { measurements.push(structuredClone(value)); },
      judges: { grounding: { provider: refusing(thrown('unavailable', { detail: 'grant-refused' })), model: 'grok-4.6' },
        prose: { provider: answering(JSON.stringify(good)), model: 'grok-4.6' } } });
    const plan = await evaluatePlan(stage, context, registry);
    const errored = measurements.find(value => value.criterionId === 'grounding')!;
    expect(errored.status).toBe('error');
    expect(errored.score).toBeNull();
    expect(errored.judgeFailure?.cause).toBe('grant-refused');
    // The instrument names the failure; it does not turn it into a zero.
    expect(errored.weight).toBe(52);
    expect(errored.weightedContribution).toBeNull();
    expect(plan.scores['writing']!.missingWeight).toBeCloseTo(0.52, 10);
    expect(plan.scores['writing']!.assessedWeight).toBeCloseTo(0.48, 10);
    expect(measurements.find(value => value.criterionId === 'prose')!.judgeFailure).toBeUndefined();
    // The stage gate inherits the named cause rather than erroring anonymously.
    expect(measurements.find(value => value.kind === 'gate')!.judgeFailure?.cause).toBe('grant-refused');
    expect(plan.stages[0]!.gate.judgeFailure?.cause).toBe('grant-refused');
  });

  it('carries a nested judge failure up through a logical composition', async () => {
    const context = evaluationContext({ judges: {
      grounding: { provider: refusing(thrown('timeout')), model: 'grok-4.6' } } });
    const composed = await evaluateNode({ id: 'gate', all: [check] }, context, registry);
    expect(composed.status).toBe('error');
    expect(composed.judgeFailure?.cause).toBe('timeout');
    const passing = await evaluateNode({ id: 'gate', all: [check] },
      evaluationContext({ judges: { grounding: { provider: answering(JSON.stringify(good)), model: 'grok-4.6' } } }), registry);
    expect(passing.judgeFailure).toBeUndefined();
  });
});

describe('the published cause is prose-free', () => {
  const secrets = ['Authorization: Bearer sk-live-should-never-appear', 'DAIMON_INFERENCE_GRANT=grant-tok-should-never-appear',
    'The newsroom article body that was being judged', 'FIXED RUBRIC\nGrade grounding.'];

  it('lets no prompt, subject text, bearer or grant token reach it', async () => {
    const leaky = thrown('unavailable', { detail: 'grant-refused',
      responseModel: 'grok-4.6', responseRoute: 'grok-broker-grant',
      prompt: secrets[3], diagnostic: { code: 'response-schema', response: { bytes: 4, sha256: 'sha256:x', text: secrets[2] } } },
    secrets.join(' | '));
    const evaluated = await judged(refusing(leaky));
    const published = JSON.stringify(evaluated.judgeFailure);
    for (const secret of secrets) expect(published).not.toContain(secret);
    expect(published).not.toMatch(/Bearer|sk-live|grant-tok|newsroom|RUBRIC/u);
    // The reason string is exactly where such prose still lives, which is why the
    // cause is a separate closed field rather than something parsed back out of it.
    expect(evaluated.reason).toContain('sk-live-should-never-appear');
    expect(Object.keys(evaluated.judgeFailure!).sort()).toEqual(['cause', 'judge', 'kind', 'providerId',
      'requestedModel', 'responseModel', 'responseRoute']);
  });

  it('refuses an unparseable answer without republishing the answer', async () => {
    const article = 'A precise report the subject wrote that must not be republished as a judge cause.';
    const evaluated = await judged(answering(article));
    expect(evaluated.judgeFailure?.cause).toBe('response-unparseable');
    expect(JSON.stringify(evaluated.judgeFailure)).not.toContain('precise report');
  });
});

describe('nothing but a typed discriminator decides a cause', () => {
  const identity = { judge: 'grounding', requestedModel: 'grok-4.6' };

  it('refuses to read a cause out of anything untyped', () => {
    // Not an Error, no discriminator, an unrecognised one, and the provider's own
    // admission that it does not know: all of them are `unclassified`, never a guess.
    expect(inferenceJudgeCause('the broker said the grant was refused')).toBe('unclassified');
    expect(inferenceJudgeCause(new Error('grant expired'))).toBe('unclassified');
    expect(inferenceJudgeCause(thrown('unknown'))).toBe('unclassified');
    // An unrecognised refinement falls back to `kind`; it never becomes a new cause.
    expect(inferenceJudgeCause(thrown('quota', { detail: 'grant-obliterated' }))).toBe('provider-error');
    expect(thrownJudgeCause(thrown('timeout'))).toBe('timeout');
  });

  it('publishes only a provider-reported status, and only on a provider error', () => {
    const invalid = [{ status: -1 }, { status: 0 }, { status: '429' }, { status: 4.5 }, {}];
    for (const extra of invalid) {
      expect(judgeFailure('provider-error', identity, thrown('quota', extra))).not.toHaveProperty('status');
    }
    expect(judgeFailure('provider-error', identity, 'not an error at all')).not.toHaveProperty('status');
    // A status reported alongside a grant refusal is not a provider status.
    expect(judgeFailure('grant-refused', identity, thrown('unavailable', { status: 503 }))).not.toHaveProperty('status');
    expect(judgeFailure('provider-error', identity, thrown('quota', { status: 503 })).status).toBe(503);
  });

  it('classifies a provider that admits it does not know through the whole judge path', async () => {
    const evaluated = await judged(refusing(thrown('unknown')));
    expect(evaluated.judgeFailure?.cause).toBe('unclassified');
    expect(evaluated.judgeFailure?.kind).toBe('unknown');
  });
});

function emptyCache(): JudgeCache {
  return { get: async () => undefined, put: async () => undefined };
}
