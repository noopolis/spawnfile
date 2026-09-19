import { describe, expect, it, vi } from 'vitest';
import type { InferenceProvider } from '../../contracts/execution.js';
import type { JudgeAttemptObservation } from '../../contracts/evaluation.js';
import { createEvaluationRegistry, evaluateNode } from '../index.js';
import { evaluationContext } from '../../testing/index.js';

const registry = createEvaluationRegistry();
const check = { id: 'grounding', eval: 'llm-rubric', input: 'artifact:article#/body',
  judge: 'grounding', rubric: { prompt: 'Grade grounding.' }, minimum: 0.8 };
const good = { score: 0.9, verdict: 'pass', reasons: ['Grounded.'], citations: [{ source: 'input', quote: 'precise' }] };
const billed = { inputTokens: 900, cachedInputTokens: 0, outputTokens: 412, reasoningTokens: null, source: 'broker-grant' };

/** A provider failure as the transport hands one over: typed discriminators, prose in the message. */
function thrown(kind: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error('provider aborted'), { kind, ...extra });
}
/**
 * The observed live signature: Grok's CLI stops part-way through a generation, bills the
 * output tokens it produced, and hands back no answer the judge can read.
 */
const abort = () => thrown('protocol', { usage: billed, responseModel: 'grok-4.6', responseRoute: 'grok-broker-grant' });

function fixture(...behaviours: (string | Error)[]) {
  const observed: JudgeAttemptObservation[] = [];
  const generate = vi.fn<InferenceProvider['generate']>(async () => {
    const next = behaviours.shift();
    if (next === undefined) throw new Error('Exceeded configured provider behaviours');
    if (next instanceof Error) throw next;
    return { text: next, model: 'grok-4.6', route: 'grok-broker-grant', usage: billed };
  });
  const provider: InferenceProvider = { id: 'grok-broker-grant',
    capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false }, generate };
  const context = evaluationContext({ judges: { grounding: { provider, model: 'grok-4.6' } },
    observeJudgeAttempt: attempt => { observed.push(structuredClone(attempt)); } });
  return { generate, context, observed };
}

describe('an aborted judge generation is re-run once, and only an aborted one', () => {
  it('recovers a judge whose first call aborted mid-generation and publishes the re-run', async () => {
    const f = fixture(abort(), JSON.stringify(good));
    const evaluated = await evaluateNode(check, f.context, registry);
    // The trial is scored rather than errored, and the score is the second call's.
    expect(evaluated.status).toBe('pass');
    expect(evaluated.score).toBe(0.9);
    expect(evaluated).not.toHaveProperty('judgeFailure');
    expect(f.generate).toHaveBeenCalledTimes(2);
    // The recovery is visible: both attempts are published, the second names the first
    // and the cause it recovered from, so a re-run score can never pass for a first one.
    const [first, second] = evaluated.judgeCalls!;
    expect(first).toMatchObject({ outcome: 'generation-error', failureKind: 'protocol', usage: billed });
    expect(first).not.toHaveProperty('retryOf');
    expect(second).toMatchObject({ outcome: 'completed', retryOf: first!.id, retryCause: 'provider-error' });
    expect(second!.id).not.toBe(first!.id);
    // Same judge, same requested model, same route: a re-run is never a fallback.
    expect(second!.judge).toBe(first!.judge);
    expect(second!.requestedModel).toBe(first!.requestedModel);
    expect(second!.providerId).toBe(first!.providerId);
    expect(f.generate.mock.calls[1]![0]!.model).toBe(f.generate.mock.calls[0]![0]!.model);
    expect(f.generate.mock.calls[1]![0]!.prompt).toBe(f.generate.mock.calls[0]![0]!.prompt);
    expect(f.generate.mock.calls[1]![0]!.system).toBe(f.generate.mock.calls[0]![0]!.system);
    // Both attempts are metered; the aborted one billed output tokens and still counts.
    expect(evaluated.usage).toEqual([billed, billed]);
    expect(f.observed).toHaveLength(2);
    expect(f.observed[1]!.call.retryOf).toBe(first!.id);
  });

  it.each([
    ['a judgement it accepted', JSON.stringify(good)],
    ['a judgement it failed', JSON.stringify({ ...good, verdict: 'fail', score: 0.2 })],
    ['an answer that was not JSON', 'not json at all'],
    ['an answer of the wrong shape', JSON.stringify({ score: 1 })],
    ['an answer citing what nobody wrote', JSON.stringify({ ...good, citations: [{ source: 'input', quote: 'invented' }] })],
    ['a schema rejection the provider typed', thrown('invalid-response')],
    ['a refused grant, whatever kind carried it', thrown('protocol', { detail: 'grant-refused' })],
    ['an expired grant', thrown('protocol', { detail: 'grant-expired' })],
    ['a quota refusal', thrown('quota', { detail: 'provider-status', status: 429 })],
    ['an unavailable broker', thrown('unavailable')],
    ['a stale credential realm', thrown('auth-stale')],
    ['an exhausted deadline', thrown('timeout')],
    ['a cancelled trial', thrown('cancelled')],
    ['a failure with no discriminator at all', new Error('no discriminator')],
    ['a transport failure the route policy already budgets for', thrown('transport')],
  ])('never asks twice after %s', async (_name, behaviour) => {
    const f = fixture(behaviour, JSON.stringify(good));
    const evaluated = await evaluateNode(check, f.context, registry);
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(evaluated.judgeCalls!.every(call => call.retryOf === undefined)).toBe(true);
    expect(evaluated.judgeCalls).toHaveLength(1);
  });

  it('never re-runs an attempt that could not be recorded, and never past a cancellation', async () => {
    // An unrecordable attempt must stop further model calls, not make another one.
    const unpersisted = fixture(abort(), JSON.stringify(good));
    unpersisted.context.observeJudgeAttempt = () => { throw new Error('sink is down'); };
    const blocked = await evaluateNode(check, unpersisted.context, registry);
    expect(blocked.judgeFailure?.cause).toBe('evidence-unpersisted');
    expect(unpersisted.generate).toHaveBeenCalledTimes(1);
    // A trial cancelled while the aborted call was in flight is not re-run either.
    const controller = new AbortController();
    const cancelled = fixture(abort(), JSON.stringify(good));
    cancelled.context.signal = controller.signal;
    cancelled.generate.mockImplementationOnce(async () => { controller.abort(); throw abort(); });
    const stopped = await evaluateNode(check, cancelled.context, registry);
    expect(stopped.status).toBe('error');
    expect(cancelled.generate).toHaveBeenCalledTimes(1);
  });

  it('fails a judge whose re-run aborts as well, with its own named cause and no score', async () => {
    const f = fixture(abort(), abort());
    const evaluated = await evaluateNode(check, f.context, registry);
    expect(evaluated.status).toBe('error');
    expect(evaluated).not.toHaveProperty('score');
    expect(evaluated.judgeFailure).toMatchObject({ cause: 'provider-error', kind: 'protocol',
      judge: 'grounding', requestedModel: 'grok-4.6', responseModel: 'grok-4.6', responseRoute: 'grok-broker-grant' });
    // One re-run, not a loop, and the second attempt still says it was one.
    expect(f.generate).toHaveBeenCalledTimes(2);
    expect(evaluated.judgeCalls).toHaveLength(2);
    expect(evaluated.judgeCalls![1]).toMatchObject({ retryOf: evaluated.judgeCalls![0]!.id,
      retryCause: 'provider-error', outcome: 'generation-error', failureKind: 'protocol' });
    // Both aborted attempts are still charged for.
    expect(evaluated.usage).toEqual([billed, billed]);
  });
});
