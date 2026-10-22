import { expect, it, vi } from 'vitest';
import type { InferenceRequest } from '../contracts/execution.js';
import type { JudgeRoute } from '../contracts/evaluation.js';
import { evaluationContext } from '../testing/index.js';
import { createEvaluationRegistry, evaluateNode, evaluatePlan, result } from './index.js';

const check = { id: 'quality', eval: 'llm-rubric', input: 'output.text', judge: 'editor',
  rubric: { prompt: 'Judge support for the stated quantity.' }, minimum: 0.8 };
const registry = createEvaluationRegistry();
function fixture(foreign = false) {
  const generate = vi.fn(async (request: InferenceRequest) => {
    const packet = JSON.parse(request.prompt.split('SOURCE DATA\n')[1]!) as { units: { id: string }[] };
    return { text: JSON.stringify({ score: 0.9, verdict: 'pass', reasons: ['Supported quantity.'],
      evidenceIds: [foreign ? 'foreign-unit' : packet.units[0]!.id] }), model: request.model, route: 'fixture',
      usage: { inputTokens: 12, outputTokens: 4, cachedInputTokens: null, reasoningTokens: null, source: 'fixture' } };
  });
  const route: JudgeRoute = { model: 'fixed', protocol: 'evidence-ids', citationRepairs: 0,
    identity: 'policy-v1', cacheScope: 'fixed-train', provider: { id: 'fixture',
      capabilities: { tools: 'disabled', billing: 'local', temperature: false, seed: false }, generate } };
  return { route, generate, context: evaluationContext({ judges: { editor: route } }) };
}

it('executes declared evidence IDs through the actual plan and node engine', async () => {
  const f = fixture();
  const plan = await evaluatePlan([{ id: 'writing', checks: [check], gate: { passed: 'quality' },
    score: { linear: { quality: 1 } } }], f.context, registry);
  expect(plan).toMatchObject({ status: 'pass', checks: { quality: { score: 0.9 } } });
  expect(f.generate).toHaveBeenCalledTimes(1);
  expect(f.generate.mock.calls[0]![0].responseSchema).toMatchObject({ required: ['score', 'verdict', 'reasons', 'evidenceIds'] });
  expect(f.generate.mock.calls[0]![0].system).toContain('evidence units');
});

it('rejects foreign IDs through the engine without legacy citation repair or an invented grade', async () => {
  const f = fixture(true);
  const measured = await evaluateNode(check, f.context, registry);
  expect(measured.status).toBe('error');
  expect(measured.score).toBeUndefined();
  expect(measured.usage).toMatchObject([{ inputTokens: 12, outputTokens: 4 }]);
  expect(f.generate).toHaveBeenCalledTimes(1);
  expect(f.generate.mock.calls[0]![0].responseSchema).toMatchObject({ required: ['score', 'verdict', 'reasons', 'evidenceIds'] });
});

it('preserves every current route policy while isolating mutable data and native method receivers', async () => {
  const f = fixture();
  f.route.template = { language: 'jinja', text: 'Original template' };
  const cache = { persistent: true, get() { expect(this).toBe(cache); return undefined; },
    put: vi.fn() };
  f.route.cache = cache;
  const custom = createEvaluationRegistry({ inspect: { definition: { version: '1', kind: 'mechanical',
    incremental: false, stopProof: false, validate() {} }, evaluate: async (_node, context) => {
    const route = context.judges.editor!;
    const { provider: _provider, cache: _cache, ...policy } = route;
    expect(policy).toEqual({ model: 'fixed', protocol: 'evidence-ids', citationRepairs: 0,
      identity: 'policy-v1', cacheScope: 'fixed-train', template: { language: 'jinja', text: 'Original template' } });
    route.protocol = 'citations'; route.template!.text = 'Mutated'; route.cache!.get('key');
    return result('pass', 'Isolated policy');
  } } });
  expect((await evaluateNode({ eval: 'inspect' }, f.context, custom)).status).toBe('pass');
  expect(f.route.protocol).toBe('evidence-ids'); expect(f.route.template.text).toBe('Original template');
});
