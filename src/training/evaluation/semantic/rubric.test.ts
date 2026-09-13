import { describe, expect, it, vi } from 'vitest';
import type { InferenceProvider } from '../../contracts/execution.js';
import { evaluateNode, createEvaluationRegistry } from '../index.js';
import { evaluationContext, snapshot } from '../../testing/index.js';

const check = { eval: 'llm-rubric', input: 'artifact:article#/body', judge: 'editor',
  rubric: { prompt: 'Grade clear prose.' }, minimum: 0.8 };
const registry = createEvaluationRegistry();
const good = { score: 0.9, verdict: 'pass', reasons: ['Clear.'], citations: [{ source: 'input', quote: 'precise' }] };
function provider(text = JSON.stringify(good)): InferenceProvider {
  return { id: 'test-subscription', capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
    generate: vi.fn(async () => ({ text, model: 'test-model', route: 'test-subscription', usage: null })) };
}
describe('fixed semantic rubrics', () => {
  it('uses explicit tool-free inference, fixed instructions and actual source spans', async () => {
    const route = provider();
    const context = evaluationContext({ judges: { editor: { provider: route, model: 'test-model' } } });
    const evaluated = await evaluateNode({ ...check, evidence: 'input:files' }, context, registry);
    expect(evaluated.status).toBe('pass');expect(evaluated.score).toBe(0.9);
    const request = vi.mocked(route.generate).mock.calls[0]![0];
    expect(request.system).toContain('untrusted data');expect(request.prompt).toContain('Source evidence');
    expect(request.model).toBe('test-model');
    expect(evaluated.evidence.some(item => item.kind === 'input')).toBe(true);
    const sidecar = { ...context, readText: async () => 'Grade source fidelity.' };
    expect((await evaluateNode({ ...check, rubric: { file: 'rubric.md' } }, sidecar, registry)).status).toBe('pass');
    const text = await evaluateNode({ ...check, input: 'output.text' },
      { ...context, snapshot: { ...context.snapshot, output: 'A precise report.' } }, registry);
    expect(text.evidence.some(item => item.digest && item.id.includes('output'))).toBe(true);
  });
  it('does not turn malformed judgments or invented citations into grades', async () => {
    for (const text of ['not json', JSON.stringify({ score: 1 }), JSON.stringify({ ...good, score: 2 }),
      JSON.stringify({ ...good, citations: [{ source: 'secret', quote: 'precise' }] }),
      JSON.stringify({ ...good, citations: [{ source: 'input', quote: 'invented quote' }] })]) {
      expect((await evaluateNode(check, evaluationContext({ judges: { editor: { provider: provider(text), model: 'test' } } }), registry)).status).toBe('error');
    }
    expect((await evaluateNode(check, evaluationContext(), registry)).status).toBe('error');
    expect((await evaluateNode(check, evaluationContext({ snapshot: snapshot({ artifacts: {} }) }), registry)).status).toBe('unknown');
    const context = evaluationContext({ judges: { editor: { provider: provider(), model: 'test' } } });
    expect((await evaluateNode({ ...check, evidence: 'artifact:missing' }, context, registry)).status).toBe('unknown');
  });
  it('retains failures, provisional checkpoint identity and observed judge usage', async () => {
    const route = provider(JSON.stringify({ ...good, verdict: 'fail' }));
    vi.mocked(route.generate).mockResolvedValueOnce({ text: JSON.stringify({ ...good, score: 0.4 }), model: 'test', route: 'subscription',
      usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 4, reasoningTokens: null, source: 'native' } });
    const context = evaluationContext({ snapshot: snapshot({ closed: false }), judges: { editor: { provider: route, model: 'test' } } });
    const evaluated = await evaluateNode(check, context, registry);
    expect(evaluated.status).toBe('fail');expect(evaluated.finality).toBe('provisional');
    expect(evaluated.evidence[0]!.id).toBe('checkpoint-1');expect(evaluated.usage?.[0]?.inputTokens).toBe(10);
    expect((await evaluateNode(check, context, registry)).status).toBe('fail');
  });
});
