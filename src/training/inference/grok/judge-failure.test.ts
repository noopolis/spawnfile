import { describe, expect, it, vi } from 'vitest';
import type { InferenceProvider } from '../../contracts/execution.js';
import type { JudgeAttemptObservation } from '../../contracts/evaluation.js';
import type { ProcessOptions, RunningProcess } from '../../platform/process/index.js';
import { createGrokInference, createRoutedInference, InferenceFailure } from '../index.js';
import { createEvaluationRegistry, evaluateNode } from '../../evaluation/index.js';
import { evaluationContext } from '../../testing/index.js';

const registry = createEvaluationRegistry();
const check = { id: 'grounding', eval: 'llm-rubric', input: 'artifact:article#/body',
  judge: 'grounding', rubric: { prompt: 'Grade grounding.' }, minimum: 0.8 };
const good = JSON.stringify({ score: 0.9, verdict: 'pass', reasons: ['Grounded.'], citations: [{ source: 'input', quote: 'precise' }] });
const billed = { inputTokens: 900, cachedInputTokens: 0, cacheWriteInputTokens: 0,
  outputTokens: 412, reasoningTokens: null, source: 'grok.result.usage.lower-bound' };

type Failure = 'tool-isolation' | 'response-mismatch' | 'unfinished-response' | 'terminal-error' | 'missing-result';
/** Feed actual native envelopes through the public adapter and its real decoder. */
function grok(failure: Failure) {
  let runs = 0;
  const process = vi.fn((options: ProcessOptions): RunningProcess => ({
    write: async () => undefined, endInput: () => undefined,
    stop: async reason => ({ state: 'acknowledged', scope: 'process-group', quiescence: 'confirmed', remoteWork: 'unknown', reason, detail: 'test' }),
    completion: (async () => {
      const first = runs++ === 0;
      const stop = first && failure === 'unfinished-response' ? 'max_tokens' : 'end_turn';
      const events = [
        { type: 'system', subtype: 'init', apiKeySource: 'oauth', tools: first && failure === 'tool-isolation' ? ['read'] : [], mcp_servers: [], model: 'model-B' },
        { type: 'assistant', session_id: 's', message: { stop_reason: stop, content: [{ type: 'text', text: good }] } },
        ...(first && failure === 'missing-result' ? [] : [{ type: 'result', subtype: first && failure === 'terminal-error' ? 'error' : 'success',
          is_error: first && failure === 'terminal-error', stop_reason: stop, session_id: 's',
          result: first && failure === 'response-mismatch' ? 'different completed answer' : good,
          usage: { input_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 412 } }]),
      ];
      try {
        for (const event of events) await options.onLine(JSON.stringify(event), new AbortController().signal);
        return { exitCode: 0, stderr: '', cancelled: false };
      } catch { return { exitCode: 1, stderr: '', cancelled: true }; }
    })(),
  }));
  const provider = createGrokInference({ process });
  const generate = vi.spyOn(provider, 'generate');
  return { provider, generate, process };
}

function context(provider: InferenceProvider) {
  const observed: JudgeAttemptObservation[] = [];
  return { observed, context: evaluationContext({ judges: { grounding: { provider, model: 'model-B' } },
    observeJudgeAttempt: attempt => { observed.push(structuredClone(attempt)); } }) };
}

describe('protocol failures have no attested pre-judgment abort', () => {
  it.each<Failure>(['tool-isolation', 'response-mismatch', 'unfinished-response', 'terminal-error', 'missing-result'])('keeps real Grok %s terminal, even if a second call would succeed', async failure => {
    const native = grok(failure);
    const f = context(native.provider);
    const evaluated = await evaluateNode(check, f.context, registry);
    expect(evaluated.status).toBe('error');
    expect(evaluated.judgeFailure).toMatchObject({ cause: 'provider-error', kind: 'protocol' });
    expect(native.generate).toHaveBeenCalledTimes(1);
    expect(native.process).toHaveBeenCalledTimes(1);
    expect(evaluated.judgeCalls).toHaveLength(1);
    expect(evaluated.judgeCalls![0]).not.toHaveProperty('retryOf');
    expect(f.observed).toHaveLength(1);
    if (failure === 'response-mismatch') {
      expect(f.observed[0]!.diagnostic?.code).toBe('response-mismatch');
      expect(evaluated.usage).toEqual([billed]);
    }
    if (failure === 'tool-isolation') expect(f.observed[0]!.diagnostic?.code).toBe('tool-isolation');
  });

  it.each(['unavailable', 'auth-stale'] as const)('does not restart A → B after A %s and B emits a real unfinished response', async kind => {
    const native = grok('unfinished-response');
    const first: InferenceProvider = { id: 'A', capabilities: { ...native.provider.capabilities, credentialAuthority: 'stale-realm' },
      generate: vi.fn(async () => { throw new InferenceFailure(kind, 'A refused'); }) };
    const excluded: InferenceProvider = { ...first, id: 'same-authority', generate: vi.fn(async () => { throw new Error('Excluded authority called'); }) };
    const routes = [{ provider: first, model: 'model-A' },
      ...(kind === 'auth-stale' ? [{ provider: excluded, model: 'excluded' }] : []),
      { provider: native.provider, model: 'model-B' }];
    const routed = createRoutedInference({ id: 'route', routes, maxAttempts: routes.length, timeoutMs: 1000 });
    const generate = vi.spyOn(routed, 'generate');
    const f = context(routed);
    const evaluated = await evaluateNode(check, f.context, registry);
    expect(evaluated.status).toBe('error');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(first.generate).toHaveBeenCalledTimes(1);
    expect(excluded.generate).not.toHaveBeenCalled();
    expect(native.generate).toHaveBeenCalledTimes(1);
    expect(evaluated.judgeCalls?.map(call => [call.providerId, call.requestedModel]))
      .toEqual([['A', 'model-A'], ['grok-subscription', 'model-B']]);
    expect(evaluated.judgeCalls!.every(call => call.retryOf === undefined)).toBe(true);
    expect(evaluated.usage).toEqual([billed]);
    expect(f.observed).toHaveLength(2);
  });

  it('stops when failure evidence cannot be persisted', async () => {
    const native = grok('response-mismatch');
    const f = context(native.provider);
    f.context.observeJudgeAttempt = () => { throw new Error('sink failed'); };
    const evaluated = await evaluateNode(check, f.context, registry);
    expect(evaluated.judgeFailure?.cause).toBe('evidence-unpersisted');
    expect(native.generate).toHaveBeenCalledTimes(1);
  });
});
