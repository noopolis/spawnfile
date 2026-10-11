import { describe, expect, it, vi } from 'vitest';
import type { DecisionRequest } from '../../contracts/grading.js';
import { createOllamaDecision, DECISION_PROMPT_VERSION, decisionPrompt } from './index.js';
import { decodeLogprobs } from './ollama.js';
import { validateDecisionRequest } from './prompt.js';

const request: DecisionRequest = { key: 'q', type: 'yes-no', instructions: 'Correct?', optionLabels: ['yes', 'no'], expectedOptions: ['yes'], projection: { text: 'data' } };
const token = (token: string, p: number) => ({ token, logprob: Math.log(p) });
const envelope = (candidates = [token('A', 0.3), token(' A', 0.3), token('B', 0.15), token(' B', 0.15)], generated = 'A') => ({ done: true,
  logprobs: [{ token: generated, top_logprobs: candidates }], message: { content: generated } });
const tags = { models: [{ name: 'm', digest: 'sha256:model' }] };
const options = { endpoint: 'http://localhost/prefix/', model: 'm' };

describe('Ollama option probabilities', () => {
  it('uses native one-token settings and exact spaced/unspaced tokens, preserving order', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async url => new Response(JSON.stringify(String(url).endsWith('/tags') ? tags : envelope([token('A', 0.2), token(' A', 0.4), token('B', 0.1), token(' B', 0.1), token('AA', 0.1)]))));
    const backend = createOllamaDecision({ ...options, fetch });
    expect(await backend.identity()).toEqual({ backend: 'ollama-logprobs', model: 'm', digest: 'sha256:model' });
    expect(await backend.score([{ ...request, system: 'judge' }])).toEqual([{ key: 'q', status: 'ok', probabilities: { yes: expect.closeTo(0.75), no: 0.25 }, bounded: false }]);
    const body = JSON.parse(fetch.mock.calls.at(-1)![1]!.body as string);
    expect(body).toMatchObject({ model: 'm', stream: false, think: false, logprobs: true, top_logprobs: 20, options: { temperature: 0, num_predict: 1 } });
    expect(body.messages[0]).toEqual({ role: 'system', content: 'judge' });
    expect(body.messages[1].content).toContain(DECISION_PROMPT_VERSION);
    expect(fetch.mock.calls[0]![0]).toBe('http://localhost/prefix/api/tags');
    expect(decisionPrompt({ ...request, type: 'score', optionLabels: [1, 2] })).toContain('A: 1\nB: 2');
    expect(decisionPrompt({ ...request, expectedOptions: ['no'] })).toBe(decisionPrompt(request));
    expect((await backend.score([request]))[0]!.status).toBe('ok');
    expect(await backend.score([])).toEqual([]);
  });
  it('bounds each omitted exact variant and gives omitted expected variants zero', () => {
    const raw = envelope([token('A', 0.8), ...Array.from({ length: 19 }, (_, i) => token(`other${i}`, 0.003))]);
    expect(decodeLogprobs(request, raw)).toMatchObject({ status: 'ok', bounded: true });
    expect(decodeLogprobs(request, raw).probabilities!.yes).toBeCloseTo(0.8 / 0.806, 12);
    expect(decodeLogprobs({ ...request, expectedOptions: ['no'] }, raw).probabilities).toEqual({ yes: 1, no: 0 });
    expect(decodeLogprobs({ ...request, expectedOptions: undefined }, raw).reason).toMatch(/Expected options/);
    expect(decodeLogprobs(request, envelope([token('A', 0.8), token('other', 0.02)])).reason).toMatch(/bound exceeds/);
    const three = { ...request, optionLabels: ['yes', 'no', 'maybe'] };
    expect(decodeLogprobs(three, envelope([token('A', 0.8), token('other', 0.006)])).status).toBe('missing');
  });
  it('rejects a top-20 list whose individually omitted variants exceed the total uncertainty budget', () => {
    const raw = envelope([token('A', 0.8), ...Array.from({ length: 19 }, (_, i) => token(`other${i}`, 0.008))]);
    expect(decodeLogprobs(request, raw)).toMatchObject({ status: 'missing', probabilities: null, reason: expect.stringMatching(/bound exceeds/) });
  });
  it('marks partially observed options bounded and preserves observed expected mass', () => {
    const raw = envelope([token('A', 0.6), token('B', 0.2), token('other', 0.004)]);
    expect(decodeLogprobs(request, raw)).toMatchObject({ status: 'ok', bounded: true,
      probabilities: { yes: expect.closeTo(0.6 / 0.804, 12), no: expect.closeTo(0.204 / 0.804, 12) } });
    expect(decodeLogprobs({ ...request, expectedOptions: ['no'] }, raw).probabilities!.no).toBeCloseTo(0.2 / 0.804, 12);
    const oneMissing = envelope([token('A', 0.4), token(' A', 0.2), token('B', 0.2), token('other', 0.009)]);
    expect(decodeLogprobs(request, oneMissing)).toMatchObject({ status: 'ok', bounded: true,
      probabilities: { yes: expect.closeTo(0.6 / 0.809, 12), no: expect.closeTo(0.209 / 0.809, 12) } });
  });
  it.each(['AA', '\nA', 'A.', ' A ', 'Z'])('refuses invalid generated token %j', generated => {
    expect(decodeLogprobs(request, envelope(undefined, generated)).reason).toMatch(/not an option/);
  });
  it('accepts one literal leading space and rejects low mass and absent/malformed candidates', () => {
    expect(decodeLogprobs(request, envelope(undefined, ' A')).status).toBe('ok');
    expect(decodeLogprobs(request, envelope([token('A', 0.2), token('B', 0.2)])).reason).toMatch(/mass below/);
    for (const value of [null, {}, { done: false }, { done: true, message: { thinking: 'reason' } }]) expect(decodeLogprobs(request, value).status).toBe('missing');
    for (const logprobs of [undefined, [], [{}], [{ token: 'A' }], [{ token: 'A', top_logprobs: [] }]]) expect(decodeLogprobs(request, { done: true, logprobs }).status).toBe('missing');
    for (const candidates of [[null], [{}], [{ token: 'A', logprob: '0' }], [{ token: 'A', logprob: Infinity }], [{ token: 'A', logprob: 1 }], [token('A', 0.4), token('A', 0.4)]]) {
      expect(decodeLogprobs(request, { done: true, logprobs: [{ token: 'A', top_logprobs: candidates }] }).reason).toMatch(/Invalid top/);
    }
  });
  it('refuses an absent model or digest and never calls chat or pull', async () => {
    for (const body of [null, {}, { models: [{ name: 'm:latest', digest: 'digest' }] }, { models: [{ name: 'm' }] }]) {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(body)));
      await expect(createOllamaDecision({ ...options, fetch }).score([request])).rejects.toThrow(/not installed/);
      expect(fetch.mock.calls.map(call => call[0])).toEqual(['http://localhost/prefix/api/tags']);
    }
    for (const model of ['', '-m']) expect(() => createOllamaDecision({ ...options, model })).toThrow(/model/);
  });
  it('refuses digest drift and propagates cancellation while reporting transport misses', async () => {
    let digest = 'one';
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ models: [{ name: 'm', digest }] })));
    const backend = createOllamaDecision({ ...options, fetch });
    await backend.identity(); digest = 'two';
    await expect(backend.score([request])).rejects.toThrow(/digest changed/);
    const failure = createOllamaDecision({ ...options, fetch: async url => {
      if (String(url).endsWith('/tags')) return new Response(JSON.stringify(tags));
      throw Error('offline');
    } });
    expect((await failure.score([request]))[0]).toMatchObject({ status: 'missing', reason: 'Ollama decision request failed' });
    await expect(failure.score([request], AbortSignal.abort())).rejects.toThrow(/cancelled/);
    const controller = new AbortController();
    const cancelled = createOllamaDecision({ ...options, fetch: async url => {
      if (String(url).endsWith('/tags')) return new Response(JSON.stringify(tags));
      controller.abort(); throw Error('cancelled');
    } });
    await expect(cancelled.score([request], controller.signal)).rejects.toThrow(/cancelled/);
  });
  it('validates question inputs without leaking expected options', () => {
    for (const patch of [{ optionLabels: ['x'] }, { optionLabels: Array.from({ length: 17 }, (_, i) => i) }, { optionLabels: ['x', 'x'] }, { optionLabels: ['', 'x'] }, { key: '' }, { instructions: '' }, { expectedOptions: ['unknown'] }]) {
      expect(() => validateDecisionRequest({ ...request, ...patch })).toThrow();
    }
  });
});
