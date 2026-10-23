import { describe, expect, it, vi } from 'vitest';
import type { InferenceProvider } from '../../contracts/execution.js';
import { evaluateNode, evaluatePlan, createEvaluationRegistry } from '../index.js';
import { artifact, evaluationContext, snapshot } from '../../testing/index.js';

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
    expect(evaluated.judgeCalls).toEqual([{ id: expect.any(String), judge: 'editor', citationRepairs: 0, providerId: 'test-subscription',
      requestedModel: 'test-model', responseModel: 'test-model', responseRoute: 'test-subscription',
      outcome: 'completed', usage: null }]);
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
  it('presents selected structured sources once and accepts original quoted input-file text', async () => {
    const passage = 'The sign says "keep left".\nThe archive is C:\\notes\\draft.txt.';
    const route = provider(JSON.stringify({ ...good,
      citations: [{ source: 'evidence', quote: passage }] }));
    const inputFiles = { 'packet.md': passage };
    const context = evaluationContext({ snapshot: snapshot({ inputFiles }),
      judges: { editor: { provider: route, model: 'test' } } });

    const evaluated = await evaluateNode({ ...check, evidence: 'input:files' }, context, registry);

    expect(evaluated.status).toBe('pass');
    const request = vi.mocked(route.generate).mock.calls[0]![0];
    const sourceData = JSON.parse(request.prompt.split('\n\nSOURCE DATA\n')[1]!);
    expect(sourceData).toEqual({ input: ['A precise report.'], evidence: inputFiles });
  });
  it.each([
    { value: ['She said "yes".', 'Another paragraph.'], quote: 'said "yes"' },
    { value: { nested: [{ text: 'First line.\nSecond line.' }] }, quote: 'line.\nSecond' },
    { value: { nested: { path: 'C:\\notes\\draft.txt' } }, quote: 'C:\\notes\\draft.txt' },
    { value: { text: 'The literal escape is \\n.' }, quote: 'escape is \\n' },
  ])('accepts an exact string leaf in selected structured artifacts: $quote', async ({ value, quote }) => {
    const context = evaluationContext({ snapshot: snapshot({ artifacts: { article: artifact(value) } }),
      judges: { editor: { provider: provider(JSON.stringify({ ...good,
        citations: [{ source: 'input', quote }] })), model: 'test' } } });
    expect((await evaluateNode({ ...check, input: 'artifact:article' }, context, registry)).status).toBe('pass');
  });
  it.each([
    { value: { nested: ['Quoted "line"', null, 7, true] }, quote: '"line"' },
    { value: { nested: ['Quoted "line"', null, 7, true] }, quote: '\\"line\\"' },
    { value: ['north', 'south'], quote: '["north","south"]' },
    { value: { count: 7, empty: null, ready: true }, quote: '"count":7,"empty":null' },
    { value: 'A literal "quote".\nA new line.', quote: '"quote".\nA new' },
  ])('retains exact serialized-source and plain-text quotations: $quote', async ({ value, quote }) => {
    const context = evaluationContext({ snapshot: snapshot({ artifacts: { article: artifact(value) } }),
      judges: { editor: { provider: provider(JSON.stringify({ ...good,
        citations: [{ source: 'input', quote }] })), model: 'test' } } });
    expect((await evaluateNode({ ...check, input: 'artifact:article' }, context, registry)).status).toBe('pass');
  });
  it.each([
    { source: 'input', quote: 'Evidence-only phrase' },
    { source: 'evidence', quote: 'Input-only phrase' },
    { source: 'packet.md', quote: 'Evidence-only phrase' },
    { source: 'toString', quote: 'Input-only phrase' },
    { source: 'input', quote: 'northsouth' },
    { source: 'input', quote: 'north\nsouth' },
    { source: 'input', quote: ' north ' },
    { source: 'input', quote: 'first second' },
    { source: 'input', quote: 'Literal\nescape' },
    { source: 'input', quote: 'INput-only phrase' },
    { source: 'input', quote: 'invented quote' },
  ])('rejects invented or transformed quotations without crossing sources: $source/$quote', async (citation) => {
    const context = evaluationContext({ snapshot: snapshot({
      artifacts: { article: artifact({ body: ['Input-only phrase', 'north', 'south',
        'first\nsecond', 'Literal\\nescape'], count: 7, empty: null, ready: true }) },
      inputFiles: { 'packet.md': 'Evidence-only phrase' },
    }), judges: { editor: { provider: provider(JSON.stringify({ ...good, citations: [citation] })), model: 'test' } } });
    const evaluated = await evaluateNode({ ...check, input: 'artifact:article', evidence: 'input:files' }, context, registry);
    expect(evaluated.status).toBe('error');
    expect(evaluated.reason).toContain('Judge citation is not present in selected evidence');
  });
  it.each(['not JSON', JSON.stringify({ score: 1 }),
    JSON.stringify({ ...good, citations: [{ source: 'input', quote: 'invented' }] })])(
    'retains measured usage and requested/reported judge identity on malformed responses: %s', async (text) => {
      const route = provider();
      const usage = { inputTokens: 50, cachedInputTokens: 12, outputTokens: 9, reasoningTokens: null,
        cacheWriteInputTokens: 6, cacheWrite5mInputTokens: 6, cacheWrite1hInputTokens: 0, source: 'observed' };
      vi.mocked(route.generate).mockResolvedValue({ text, model: 'resolved-model', route: 'returned-route', usage });
      const context = evaluationContext({ judges: { editor: { provider: route, model: 'requested-alias' } } });

      const evaluated = await evaluateNode(check, context, registry);

      expect(evaluated.status).toBe('error');
      expect(evaluated.usage).toEqual([usage]);
      expect(evaluated.judgeCalls).toEqual([{ id: expect.any(String), judge: 'editor', citationRepairs: 0,
        providerId: 'test-subscription', requestedModel: 'requested-alias', responseModel: 'resolved-model',
        responseRoute: 'returned-route', outcome: 'invalid-response', usage }]);
      expect(evaluated.evidence).not.toHaveLength(0);
    });
  it('records failed generation attempts with explicitly unknown response identity and usage', async () => {
    const route = provider();
    vi.mocked(route.generate).mockRejectedValueOnce(new Error('quota unavailable')).mockRejectedValueOnce('provider failed');
    const context = evaluationContext({ judges: { editor: { provider: route, model: 'requested-model' } } });
    const first = await evaluateNode(check, context, registry);
    expect(first).toMatchObject({ status: 'error', reason: 'quota unavailable', judgeCalls: [{
      judge: 'editor', providerId: 'test-subscription', requestedModel: 'requested-model',
      responseModel: null, responseRoute: null, usage: null, outcome: 'generation-error',
    }] });
    expect(first.usage).toBeUndefined();
    const second = await evaluateNode(check, context, registry);
    expect(second.reason).toBe('provider failed');
    expect(second.judgeCalls![0]!.id).not.toBe(first.judgeCalls![0]!.id);
    expect((await evaluateNode(check, { ...context, signal: AbortSignal.abort() }, registry)).judgeCalls).toBeUndefined();
    expect(route.generate).toHaveBeenCalledTimes(2);
  });

  it.each([JSON.stringify(good), 'malformed JSON'])('keeps inferred model identity unknown while retaining usage: %s', async text => {
    const route = provider();
    const usage = { inputTokens: 50, cachedInputTokens: 12, outputTokens: 9, reasoningTokens: null, source: 'native' };
    vi.mocked(route.generate).mockResolvedValue({ text, model: 'requested-model', modelBasis: 'requested-assumption',
      route: 'returned-route', usage });
    const evaluated = await evaluateNode(check, evaluationContext({ judges: { editor: { provider: route, model: 'requested-model' } } }), registry);
    expect(evaluated.judgeCalls![0]).toMatchObject({ requestedModel: 'requested-model', responseModel: null, usage });
    expect(evaluated.usage).toEqual([usage]);
  });
  it('keeps distinct judge routes and counts checks, semantic eligibility and gates once per actual call', async () => {
    const editor = provider();
    const factChecker = { ...provider(), id: 'second-subscription' };
    const measured = { inputTokens: 20, cachedInputTokens: 2, outputTokens: 5, reasoningTokens: null, source: 'observed' };
    vi.mocked(editor.generate).mockResolvedValue({ text: JSON.stringify(good), model: 'editor-resolved', route: 'editor-route', usage: measured });
    vi.mocked(factChecker.generate).mockResolvedValue({ text: 'invalid JSON', model: 'facts-resolved', route: 'facts-route', usage: measured });
    const context = evaluationContext({ judges: {
      editor: { provider: editor, model: 'editor-alias' },
      facts: { provider: factChecker, model: 'facts-alias' },
    } });
    const evaluated = await evaluatePlan([{ id: 'first', when: check,
      checks: [{ ...check, id: 'prose' }, { ...check, id: 'fidelity', judge: 'facts' }],
      gate: { any: [{ passed: 'prose' }, { not: { passed: 'prose' } }, { passed: 'fidelity' }, check] },
    }, { id: 'second', when: { passed: 'first' }, checks: [{ id: 'again', passed: 'prose' }],
      gate: { passed: 'again' } }], context, registry);

    expect(editor.generate).toHaveBeenCalledTimes(3);
    expect(factChecker.generate).toHaveBeenCalledTimes(1);
    expect(evaluated.judgeCalls).toHaveLength(4);
    expect(new Set(evaluated.judgeCalls!.map(call => call.id)).size).toBe(4);
    expect(evaluated.judgeCalls!.filter(call => call.judge === 'editor')).toHaveLength(3);
    expect(evaluated.judgeCalls!.find(call => call.judge === 'facts')).toMatchObject({
      providerId: 'second-subscription', requestedModel: 'facts-alias', responseModel: 'facts-resolved',
      responseRoute: 'facts-route', usage: measured, outcome: 'invalid-response',
    });
    expect(evaluated.stages[0]!.gate.judgeCalls).toHaveLength(3);
    const denied = await evaluatePlan([{ id: 'blocked', when: { ...check, judge: 'facts' },
      checks: [{ ...check, id: 'unreached' }] }], context, registry);
    expect(denied.judgeCalls).toHaveLength(1);
    expect(denied.judgeCalls![0]!.outcome).toBe('invalid-response');
    expect(denied.checks.unreached!.status).toBe('skipped');
    expect(editor.generate).toHaveBeenCalledTimes(3);
  });
});
