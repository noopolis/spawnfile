import { expect, it, vi } from 'vitest';
import type { InferenceProvider } from '../../contracts/execution.js';
import type { JudgeAttemptObservation } from '../../contracts/evaluation.js';
import { evaluateNode, createEvaluationRegistry } from '../index.js';
import { artifact, evaluationContext, snapshot } from '../../testing/index.js';

const check = { eval: 'llm-rubric', input: 'artifact:article', evidence: 'input:files', judge: 'prose',
  rubric: { prompt: 'Fixed prose rubric.' }, minimum: 0.8 };
const registry = createEvaluationRegistry();
const citations = [{ source: 'input', quote: 'Literal "phrase".\nSecond line.' }];
const judgment = { score: 0.52, verdict: 'fail', reasons: ['Needs revision.'], citations };
const invalid = { ...judgment, citations: [{ source: 'input', quote: 'invented' }] };
const usage = { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningTokens: null, source: 'test' };
function fixture(replies: (string | Error)[], repairs: 0 | 1 = 1) {
  const observed: JudgeAttemptObservation[] = [];
  const generate = vi.fn<InferenceProvider['generate']>(async () => {
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    if (reply === undefined) throw new Error('Exceeded configured replies');
    return { text: reply, model: 'actual', route: 'subscription-test', usage };
  });
  const provider: InferenceProvider = { id: 'test', capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false }, generate };
  const context = evaluationContext({ snapshot: snapshot({ artifacts: { article: artifact({ body: [citations[0]!.quote, 'next paragraph'] }) },
    inputFiles: { packet: 'Evidence-only material.' } }),
    judges: { prose: { provider, model: 'requested', citationRepairs: repairs } },
    observeJudgeAttempt: attempt => { observed.push(attempt); } });
  return { generate, context, observed };
}

it('repairs only citations once and preserves the original failing score, verdict and reasons', async () => {
  const f = fixture([JSON.stringify(invalid), JSON.stringify({ citations })]);
  const evaluated = await evaluateNode(check, f.context, registry);
  expect(evaluated).toMatchObject({ status: 'fail', score: 0.52, reason: 'Needs revision.' });
  expect(f.generate).toHaveBeenCalledTimes(2);
  const [first, second] = evaluated.judgeCalls!;
  expect(first).toMatchObject({ outcome: 'invalid-response', citationRepairs: 1, usage });
  expect(second).toMatchObject({ outcome: 'completed', repairOf: first!.id, citationRepairs: 1, usage });
  expect(first!.id).not.toBe(second!.id);
  expect(evaluated.usage).toEqual([usage, usage]);
  expect(f.observed).toHaveLength(2);
  expect(f.observed[0]).toMatchObject({ response: JSON.stringify(invalid), violation: { code: 'invalid-citations',
    citations: [{ index: 0, source: 'input', reason: 'quote-not-found' }] } });
  expect(f.observed[1]!.response).toBe(JSON.stringify({ citations }));
  expect(evaluated).not.toHaveProperty('response');
  expect(JSON.stringify(evaluated)).not.toContain('invented');
  const [initial, repair] = f.generate.mock.calls.map(call => call[0]);
  expect(repair!.model).toBe(initial!.model);
  expect(repair!.prompt).toContain(initial!.prompt);
  expect(repair!.system).toContain('only citations');
  expect(initial!.system).toContain('literal ID "input" or "evidence"');
  expect(initial!.system).toContain('Never use a URL, filename, article section or publication name as source');
  expect(repair!.system).toContain('{"citations":[{"source":"input","quote":"exact source substring"}]}');
  expect(repair!.system).not.toContain('"source":"input or evidence"');
  expect(initial!.system).toContain('with score (0..1)');
  expect(repair!.system).not.toContain('with score (0..1)');
  expect(repair!.system).not.toContain('nonempty reasons[]');
  expect(repair!.system).toContain('literal ID "input" or "evidence"');
});

it.each([undefined, 0] as const)('defaults to no repair and records the disabled policy (%j)', async citationRepairs => {
  const f = fixture([JSON.stringify(invalid)]);
  f.context.judges.prose!.citationRepairs = citationRepairs;
  const evaluated = await evaluateNode(check, f.context, registry);
  expect(evaluated.status).toBe('error');
  expect(evaluated.judgeCalls).toHaveLength(1);
  expect(evaluated.judgeCalls![0]!.citationRepairs).toBe(0);
  expect(f.generate).toHaveBeenCalledTimes(1);
});

it.each([JSON.stringify(judgment), JSON.stringify({ ...judgment, score: 0.95, verdict: 'pass' }),
  'not JSON', JSON.stringify({ score: 0.9 }), new Error('quota unavailable')])(
  'never retries a valid grade, invalid JSON/shape or provider failure (%j)', async reply => {
    const f = fixture([reply]);
    await evaluateNode(check, f.context, registry);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

it.each([JSON.stringify({ citations: [{ source: 'input', quote: 'invented again' }] }),
  JSON.stringify({ citations: [{ source: 'evidence', quote: citations[0]!.quote }] }),
  JSON.stringify({ citations: [{ source: 'input', quote: 'Second line.next paragraph' }] }),
  JSON.stringify({ citations: [{ source: 'input', quote: 'Literal "phrase". Second line.' }] }),
  JSON.stringify({ citations: [{ source: 'packet', quote: 'Evidence-only material.' }] }),
  JSON.stringify({ citations: [{ source: 'article body', quote: citations[0]!.quote }] }),
  JSON.stringify({ citations: [{ source: 'iea.org', quote: 'Evidence-only material.' }] }),
  JSON.stringify({ citations: [...citations, { source: 'input', quote: 'invented' }] }),
  JSON.stringify({ ...judgment, score: 1, verdict: 'pass' }), 'not JSON', new Error('quota unavailable')])(
  'rejects a bad repair without a third attempt or relaxed exact-match rules (%j)', async reply => {
    const f = fixture([JSON.stringify(invalid), reply]);
    const evaluated = await evaluateNode(check, f.context, registry);
    expect(evaluated.status).toBe('error');
    expect(evaluated.judgeCalls).toHaveLength(2);
    expect(f.generate).toHaveBeenCalledTimes(2);
    expect(evaluated.judgeCalls![1]!.outcome).toBe(reply instanceof Error ? 'generation-error' : 'invalid-response');
  });

it('does not repair after cancellation, observation failure or an invalid policy', async () => {
  const f = fixture([JSON.stringify(invalid)]), controller = new AbortController();
  f.context.signal = controller.signal;
  f.context.observeJudgeAttempt = () => { controller.abort(); };
  expect((await evaluateNode(check, f.context, registry)).status).toBe('error');
  expect(f.generate).toHaveBeenCalledTimes(1);
  const broken = fixture([JSON.stringify(invalid)]);
  broken.context.observeJudgeAttempt = () => { throw new Error('PRIVATE OBSERVER ERROR'); };
  const failed = await evaluateNode(check, broken.context, registry);
  expect(failed).toMatchObject({ status: 'error', reason: 'Judge attempt evidence persistence failed' });
  expect(failed.judgeCalls![0]!.usage).toEqual(usage);
  expect(broken.generate).toHaveBeenCalledTimes(1);
  const policy = fixture([]); policy.context.judges.prose!.citationRepairs = 2 as 1;
  expect((await evaluateNode(check, policy.context, registry)).status).toBe('error');
  expect(policy.generate).not.toHaveBeenCalled();
});

it('freezes the selected source/model/policy before a caller can mutate them during inference', async () => {
  const f = fixture([JSON.stringify(invalid), JSON.stringify({ citations })]);
  f.context.observeJudgeAttempt = attempt => {
    f.context.judges.prose!.model = 'changed';
    f.context.judges.prose!.citationRepairs = 0;
    f.context.snapshot.artifacts['article']!.value = { body: ['changed'] };
    attempt.call.usage!.inputTokens = 999;
  };
  const evaluated = await evaluateNode(check, f.context, registry);
  expect(evaluated.status).toBe('fail');
  expect(evaluated.judgeCalls!.map(call => call.requestedModel)).toEqual(['requested', 'requested']);
  expect(evaluated.judgeCalls!.map(call => call.usage!.inputTokens)).toEqual([10, 10]);
});

it('retains both usages when persistence of the repair response fails, without accepting its verdict', async () => {
  const f = fixture([JSON.stringify(invalid), JSON.stringify({ citations })]);
  let observed = 0;
  f.context.observeJudgeAttempt = () => { if (++observed === 2) throw new Error('PRIVATE SINK FAILURE'); };
  const evaluated = await evaluateNode(check, f.context, registry);
  expect(evaluated).toMatchObject({ status: 'error', reason: 'Judge attempt evidence persistence failed', usage: [usage, usage] });
  expect(f.generate).toHaveBeenCalledTimes(2);
  expect(evaluated).not.toHaveProperty('score');
});
