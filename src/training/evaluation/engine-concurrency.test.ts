import { parseGrader, createCalibrationIdentity, decisionBackendIdentity, type GradingRuntime } from '../graders/index.js';
import { describe, expect, it, vi } from 'vitest';
import { createEvaluationRegistry, createJudgeCache, evaluatePlan, result } from './index.js';
import { evaluationContext, observation, snapshot } from '../testing/index.js';
import type { CheckNode, Stage } from '../contracts/dataset.js';
import type { EvaluationContext, EvaluationMeasurement, JudgeAttemptObservation, JudgeRoute, PlanEvaluation } from '../contracts/evaluation.js';
import type { InferenceProvider, InferenceRequest, InferenceResult } from '../contracts/execution.js';

const registry = createEvaluationRegistry();
const judgment = (score: number) => JSON.stringify({ score, verdict: score >= 0.5 ? 'pass' : 'fail', reasons: [`score ${score}`],
  citations: [{ source: 'input', quote: 'precise' }] });
const rubric = (id: string, judge: string, prompt = `Grade ${id}.`) => ({ id, eval: 'llm-rubric', input: 'artifact:article#/body',
  judge, rubric: { prompt }, minimum: 0.5 });

interface Pending { judge: string; request: InferenceRequest; resolve(text: string): void; reject(error: unknown): void }
/** Deferred providers expose every in-flight generation so tests control completion order. */
function deferredJudges(names: readonly string[]) {
  const pending: Pending[] = [];
  const judges: Record<string, JudgeRoute> = {};
  for (const judge of names) {
    const provider: InferenceProvider = { id: `fixture-${judge}`,
      capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
      generate: vi.fn((request: InferenceRequest) => new Promise<InferenceResult>((resolve, reject) => {
        pending.push({ judge, request, reject,
          resolve: text => resolve({ text, model: 'fixture-model', route: 'fixture', usage: null }) });
      })) };
    judges[judge] = { provider, model: 'fixture-model' };
  }
  return { pending, judges };
}
const inFlight = (pending: Pending[], count: number) => vi.waitFor(() => expect(pending).toHaveLength(count), { timeout: 400, interval: 5 });
const find = (pending: Pending[], judge: string) => pending.find(entry => entry.judge === judge)!;
/** Call IDs are random per attempt; everything else must be byte-equal. */
function normalized(plan: PlanEvaluation): unknown {
  return JSON.parse(JSON.stringify(plan, (key, value: unknown) => key === 'id' && typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value) ? 'call' : value));
}
const stages = (): Stage[] => [{ id: 'writing', checks: [
  rubric('grounding', 'grounding'),
  { id: 'format', eval: 'equals', input: 'output.text', value: '4' },
  rubric('prose', 'prose'),
  { id: 'both', all: [{ passed: 'grounding' }, { passed: 'prose' }] },
], score: { linear: { grounding: 1, prose: 1 } }, gate: { all: [{ passed: 'both' }] } }];

async function run(concurrency: number, order: readonly string[], context: Partial<EvaluationContext> = {}) {
  const { pending, judges } = deferredJudges(['grounding', 'prose']);
  const measurements: EvaluationMeasurement[] = [];
  const attempts: JudgeAttemptObservation[] = [];
  const plan = evaluatePlan(stages(), evaluationContext({ judges, checkConcurrency: concurrency, ...context,
    observeMeasurement: async value => { measurements.push(value); },
    observeJudgeAttempt: async value => { attempts.push(value); } }), registry);
  for (const judge of order) {
    await vi.waitFor(() => expect(pending.some(entry => entry.judge === judge)).toBe(true), { timeout: 400, interval: 5 });
    find(pending, judge).resolve(judge === 'grounding' ? judgment(0.9) : judgment(0.7));
  }
  return { plan: await plan, measurements, attempts, pending };
}

describe('concurrent independent judges', () => {
  it('starts independent judges of one stage together instead of waiting for the first verdict', async () => {
    const { pending, judges } = deferredJudges(['grounding', 'prose']);
    const plan = evaluatePlan(stages(), evaluationContext({ judges }), registry);
    // Mutation evidence: forcing sequential scheduling leaves only grounding in flight here.
    await inFlight(pending, 2);
    expect(pending.map(entry => entry.judge)).toEqual(['grounding', 'prose']);
    find(pending, 'prose').resolve(judgment(0.7));
    find(pending, 'grounding').resolve(judgment(0.9));
    expect((await plan).status).toBe('pass');
  });

  it('records the same results, judge calls and measurement order as strictly sequential evaluation', async () => {
    const sequential = await run(1, ['grounding', 'prose']);
    const concurrent = await run(2, ['prose', 'grounding']);
    expect(normalized(concurrent.plan)).toEqual(normalized(sequential.plan));
    expect(concurrent.measurements).toEqual(sequential.measurements);
    expect(concurrent.measurements.map(value => value.criterionId)).toEqual(['grounding', 'format', 'prose', 'both', 'writing']);
    expect(concurrent.plan.judgeCalls!.map(call => call.judge)).toEqual(['grounding', 'prose']);
    expect(Object.keys(concurrent.plan.checks)).toEqual(Object.keys(sequential.plan.checks));
    expect(concurrent.plan.stages[0]!.checks.map(check => check.id)).toEqual(['grounding', 'format', 'prose', 'both']);
    // Every audited attempt is still persisted before its judgment is accepted.
    expect(concurrent.attempts.map(value => value.call.judge).sort()).toEqual(['grounding', 'prose']);
    expect(concurrent.attempts.map(value => value.call.id).sort()).toEqual(concurrent.plan.judgeCalls!.map(call => call.id).sort());
  });

  it('settles a failed judge beside a successful one exactly like sequential evaluation', async () => {
    const outcome = async (concurrency: number) => {
      const { pending, judges } = deferredJudges(['grounding', 'prose']);
      const plan = evaluatePlan(stages(), evaluationContext({ judges, checkConcurrency: concurrency }), registry);
      await vi.waitFor(() => expect(pending.some(entry => entry.judge === 'grounding')).toBe(true));
      if (concurrency > 1) {
        await inFlight(pending, 2);
        find(pending, 'prose').resolve(judgment(0.7));
      }
      find(pending, 'grounding').reject(new Error('provider down'));
      if (concurrency === 1) {
        await vi.waitFor(() => expect(pending.some(entry => entry.judge === 'prose')).toBe(true));
        find(pending, 'prose').resolve(judgment(0.7));
      }
      return plan;
    };
    const concurrent = await outcome(2);
    expect(concurrent.checks.grounding).toMatchObject({ status: 'error', reason: 'provider down' });
    expect(concurrent.checks.prose!.status).toBe('pass');
    expect(concurrent.status).toBe('error');
    expect(normalized(concurrent)).toEqual(normalized(await outcome(1)));
  });

  it('cancels every in-flight judge and still returns one settled plan', async () => {
    const controller = new AbortController();
    const { pending, judges } = deferredJudges(['grounding', 'prose']);
    const plan = evaluatePlan(stages(), evaluationContext({ judges, signal: controller.signal }), registry);
    await inFlight(pending, 2);
    for (const entry of pending) entry.request.signal!.addEventListener('abort', () => entry.reject(new Error('Judge evaluation cancelled')));
    controller.abort();
    const settled = await plan;
    expect(settled.checks.grounding!.status).toBe('error');
    expect(settled.checks.prose!.status).toBe('error');
    // Work that started before cancellation keeps its own outcome; nothing starts afterwards.
    expect(settled.checks.format!.status).toBe('pass');
    expect(settled.checks.both).toMatchObject({ status: 'error', reason: 'Evaluation cancelled' });
    expect(settled.status).toBe('error');
  });

  it('waits for started judges before surfacing a durable measurement failure and starts no dependent work', async () => {
    const { pending, judges } = deferredJudges(['grounding', 'prose', 'late']);
    const after = vi.fn(async () => result('pass', 'must not run'));
    const custom = createEvaluationRegistry({ after: {
      definition: { version: '1', kind: 'mechanical', incremental: false, stopProof: false, validate() {} }, evaluate: after } });
    const checks = [rubric('grounding', 'grounding'), rubric('prose', 'prose'), rubric('late', 'late'), { id: 'after', eval: 'after' }];
    const sink = vi.fn(async () => { throw new Error('durable sink failed'); });
    const plan = evaluatePlan([{ id: 'writing', checks }], evaluationContext({ judges, observeMeasurement: sink }), custom);
    let rejected = false;
    plan.catch(() => { rejected = true; });
    await inFlight(pending, 2);
    find(pending, 'grounding').resolve(judgment(0.9));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(rejected).toBe(false);
    // A check that won a slot before the failure was recorded still settles before rejection.
    for (const entry of pending.filter(value => value.judge !== 'grounding')) entry.resolve(judgment(0.7));
    await new Promise(resolve => setTimeout(resolve, 20));
    for (const entry of pending.filter(value => value.judge === 'late')) entry.resolve(judgment(0.7));
    await expect(plan).rejects.toThrow('durable sink failed');
    expect(after).not.toHaveBeenCalled();
    expect(sink).toHaveBeenCalledTimes(1);
    // The queued judge only receives grounding's slot once that commit has failed.
    expect(pending.map(entry => entry.judge)).toEqual(['grounding', 'prose']);
  });

  it('serializes checks sharing a judge cache so a duplicate still reuses the first verdict', async () => {
    const { pending, judges } = deferredJudges(['grounding']);
    judges.grounding = { ...judges.grounding!, identity: 'grounding-v1', cache: createJudgeCache({ maxEntries: 10 }) };
    const plan = evaluatePlan([{ id: 'writing', checks: [rubric('first', 'grounding', 'Same.'), rubric('second', 'grounding', 'Same.')] }],
      evaluationContext({ judges }), registry);
    await inFlight(pending, 1);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(pending).toHaveLength(1);
    pending[0]!.resolve(judgment(0.9));
    const settled = await plan;
    expect(judges.grounding.provider.generate).toHaveBeenCalledTimes(1);
    expect(settled.checks.second!.cache?.sourceCallId).toBe(settled.checks.first!.judgeCalls![0]!.id);
  });

  it('keeps evaluators without an independence declaration behind every earlier result', async () => {
    const { pending, judges } = deferredJudges(['grounding']);
    const seen: string[][] = [];
    const custom = createEvaluationRegistry({ reader: {
      definition: { version: '1', kind: 'mechanical', incremental: false, stopProof: false, validate() {} },
      evaluate: async (_check, context) => { seen.push(Object.keys(context.results)); return result('pass', 'read siblings'); },
    } });
    const plan = evaluatePlan([{ id: 'writing', checks: [rubric('grounding', 'grounding'), { id: 'reader', eval: 'reader' }] }],
      evaluationContext({ judges, checkConcurrency: 4 }), custom);
    await inFlight(pending, 1);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(seen).toEqual([]);
    pending[0]!.resolve(judgment(0.9));
    await plan;
    expect(seen).toEqual([['grounding']]);
  });

  it('declares shared stateful resources for builtin inference evaluators only', () => {
    const embedding = { id: 'local', version: 'v1', embed: async () => ({ vectors: [[1]], usage: null }) };
    const cache = createJudgeCache({ maxEntries: 1 });
    const context = evaluationContext({ embeddings: { local: embedding },
      judges: { cached: { provider: deferredJudges(['x']).judges.x!.provider, model: 'm', cache } } });
    expect(registry['embedding-similarity']!.concurrency!({ eval: 'embedding-similarity', provider: 'local' }, context)).toEqual([embedding]);
    expect(registry['embedding-similarity']!.concurrency!({ eval: 'embedding-similarity', provider: 'toString' }, context)).toEqual([]);
    expect(registry['llm-rubric']!.concurrency!({ eval: 'llm-rubric', judge: 'cached' }, context)).toEqual([cache]);
    expect(registry['llm-rubric']!.concurrency!({ eval: 'llm-rubric', judge: 42 }, context)).toEqual([]);
    expect(registry['tool-called']!.concurrency!({ eval: 'tool-called' }, context)).toEqual([]);
  });

  it('enforces that every builtin opted into concurrency never reads sibling results or scores', async () => {
    const good = { score: 0.9, verdict: 'pass', reasons: ['ok'], citations: [{ source: 'input', quote: 'precise' }] };
    const embedding = { id: 'local', version: '1', embed: async () => ({ vectors: [[1, 0], [1, 0]], usage: null }) };
    const judge = deferredJudges(['editor']).judges.editor!;
    judge.provider.generate = async () => ({ text: JSON.stringify(good), model: 'm', route: 'r', usage: null });
    const definition = parseGrader({ schema: 'paideia.grader.v1', id: 'g', golden: 'g', calibration: 'c',
      teachers: [{ id: 't', provider: 'claude', model: 'm' }], model: { backend: 'teacher', teacher: 't' },
      escalate: { to: 't', between: [0.4, 0.6] }, score: { method: 'weighted' },
      questions: [{ id: 'q', type: 'yes-no', expected: 'yes', reads: ['output.body'] }] });
    const backend: GradingRuntime['backend'] = { identity: async () => ({ backend: 'teacher', model: 'm' }),
      score: async requests => requests.map(request => ({ key: request.key, status: 'ok', probabilities: { yes: 1, no: 0 } })) };
    const digest = 'a'.repeat(64);
    const identity = createCalibrationIdentity(definition, { backendModel: await decisionBackendIdentity(definition, backend),
      golden: digest, promptTemplateVersion: 'v1', seed: '', exclusions: [] });
    const grader: GradingRuntime = { grader: definition, backend, resource: {}, goldenDigest: digest, promptTemplateVersion: 'v1',
      definitionDigest: digest, calibrationDigest: digest, calibration: { schema: 'paideia.grader-calibration.v1', identity,
        questions: { q: { status: 'calibrated', failures: [],
      teacherAccuracy: { groups: 20, instances: 40, good: 20, bad: 20, agreement: 1, source: 'human', failures: [], warnings: [] }, metrics: { groups: 20, instances: 40, good: 20, bad: 20, baseRate: 0.5 } } } } };
    const cases: Record<string, CheckNode> = {
      grader: { eval: 'grader', grader: 'g', input: 'artifact:article', grader_binding: { definitionDigest: digest, calibrationDigest: digest, gates: [] } },
      equals: { eval: 'equals', input: 'output.text', value: '4' },
      'contains-any': { eval: 'contains-any', input: 'artifact:article#/body', values: ['precise'] },
      'json-schema': { eval: 'json-schema', input: 'artifact:article', schema: { type: 'object' } },
      'tool-called': { eval: 'tool-called', tool: 'validate' },
      'tool-count': { eval: 'tool-count', tool: 'validate', at_least: 1 },
      'tool-sequence': { eval: 'tool-sequence', order: 'happens-before', steps: [{ tool: 'validate' }] },
      'token-efficiency': { eval: 'token-efficiency', metric: 'total', target_tokens: 1000 },
      'llm-rubric': rubric('grade', 'editor'),
      'embedding-similarity': { eval: 'embedding-similarity', input: 'output.text', reference: 'reference.txt',
        provider: 'local', model: 'test-vector', metric: 'cosine', calibration: 'calibration.json', minimum: 0.8 },
    };
    const opted = Object.entries(registry).filter(([, entry]) => entry.concurrency).map(([id]) => id).sort();
    expect(opted).toEqual(Object.keys(cases).sort());
    for (const [id, check] of Object.entries(cases)) {
      const context = evaluationContext({ graders: { g: grader }, judges: { editor: { ...judge, model: 'm' } }, embeddings: { local: embedding },
        snapshot: snapshot({ events: [observation()], subjectUsage: { status: 'complete', usage: { inputTokens: 800, cachedInputTokens: 0,
          outputTokens: 200, reasoningTokens: 0, source: 'native-total' } } }),
        readText: async path => path === 'calibration.json' ? JSON.stringify({ model: 'test-vector', metric: 'cosine', version: '1' }) : 'reference' });
      for (const field of ['results', 'scores'] as const) {
        Object.defineProperty(context, field, { get: () => { throw new Error(`${id} read sibling ${field}`); } });
      }
      const evaluated = await registry[id]!.evaluate(structuredClone(check), context);
      expect(evaluated.status, `${id}: ${evaluated.reason}`).not.toBe('error');
    }
  });

  it('lets a judge start at bound one while a built-in mechanical check is still pending', async () => {
    const { pending, judges } = deferredJudges(['grounding']);
    let releaseSchema!: (text: string) => void;
    const schema = new Promise<string>(resolve => { releaseSchema = resolve; });
    const plan = evaluatePlan([{ id: 'writing', checks: [
      { id: 'shape', eval: 'json-schema', input: 'artifact:article', schema: 'schema.json' }, rubric('grounding', 'grounding'),
    ] }], evaluationContext({ judges, checkConcurrency: 1, readText: () => schema }), registry);
    // Mutation evidence: slotting built-in mechanical checks leaves the judge queued here.
    await inFlight(pending, 1);
    releaseSchema(JSON.stringify({ type: 'object' }));
    pending[0]!.resolve(judgment(0.9));
    const settled = await plan;
    expect(settled.checks.shape!.status).toBe('pass');
    expect(Object.keys(settled.checks)).toEqual(['shape', 'grounding', 'writing']);
  });

  it('always slots custom evaluators, even when they declare a mechanical kind', async () => {
    const { pending, judges } = deferredJudges(['grounding']);
    let finish!: () => void;
    const custom = createEvaluationRegistry({ spender: {
      definition: { version: '1', kind: 'mechanical', incremental: false, stopProof: false, validate() {} },
      concurrency: () => [],
      evaluate: () => new Promise(resolve => { finish = () => resolve(result('pass', 'could have spent inference')); }),
    } });
    const plan = evaluatePlan([{ id: 'writing', checks: [{ id: 'spender', eval: 'spender' }, rubric('grounding', 'grounding')] }],
      evaluationContext({ judges, checkConcurrency: 1 }), custom);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(pending).toHaveLength(0);
    finish();
    await inFlight(pending, 1);
    pending[0]!.resolve(judgment(0.9));
    expect((await plan).status).toBe('pass');
  });

  it('settles dependent, bound-one and all-mechanical graphs within a bounded time', async () => {
    const immediate: Record<string, JudgeRoute> = {};
    for (const name of ['grounding', 'prose']) {
      immediate[name] = { model: 'm', provider: { id: name, capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
        generate: async () => ({ text: judgment(0.9), model: 'm', route: 'r', usage: null }) } };
    }
    const mechanical = { id: 'format', eval: 'equals', input: 'output.text', value: '4' };
    const graphs: [Stage[], number][] = [
      [[{ id: 'deps', checks: [{ id: 'a', passed: 'missing' }, { id: 'b', all: [{ passed: 'a' }] }, { id: 'c', not: { passed: 'b' } }] }], 2],
      [stages(), 1],
      [[{ id: 'mech', checks: [mechanical, { ...mechanical, id: 'again' }, { id: 'count', eval: 'tool-count', tool: 'x', at_most: 1 }] }], 1],
      [[{ id: 'mech', checks: [mechanical, { ...mechanical, id: 'again' }] }, { id: 'next', when: { passed: 'mech' }, checks: [rubric('grounding', 'grounding')] }], 8],
    ];
    for (const [plan, checkConcurrency] of graphs) {
      const timeout = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('evaluation hung')), 1000));
      await expect(Promise.race([evaluatePlan(plan, evaluationContext({ judges: immediate, checkConcurrency }), registry), timeout])).resolves.toBeDefined();
    }
  });

  it('rejects an invalid concurrency bound before any evaluation', async () => {
    for (const value of [0, 9, 1.5]) {
      await expect(evaluatePlan(stages(), evaluationContext({ checkConcurrency: value }), registry)).rejects.toThrow('concurrency');
    }
  });
});
