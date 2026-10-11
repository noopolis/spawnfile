import { describe, expect, it, vi } from 'vitest';
import type { DecisionRequest } from '../../contracts/grading.js';
import { createJevDecision, createOllamaDecision } from './index.js';

const request: DecisionRequest = { key: 'q', type: 'yes-no', optionLabels: ['yes', 'no'], instructions: 'Question?', projection: {} };
const tags = { models: [{ name: 'm', digest: 'sha256:model' }] };
const success = (url: string, init?: RequestInit) => {
  if (url.endsWith('/version')) return new Response(JSON.stringify({ version: '0.34.0' }));
  if (url.endsWith('/tags')) return new Response(JSON.stringify(tags));
  if (url.endsWith('/chat')) return new Response(JSON.stringify({ done: true, logprobs: [{ token: 'A',
    top_logprobs: ['A', ' A', 'B', ' B'].map(token => ({ token, logprob: Math.log(0.25) })) }] }));
  const { questions } = JSON.parse(init!.body as string) as { questions: Record<string, unknown> };
  return new Response(JSON.stringify({ model: 'm', answers: Object.fromEntries(Object.keys(questions)
    .map(key => [key, { probabilities: { true: 0.5, false: 0.5 } }])) }));
};

for (const backendName of ['jev', 'ollama'] as const) {
  describe(`${backendName} rejected decision requests`, () => {
    const create = (fetch: typeof globalThis.fetch, timeoutMs?: number) => backendName === 'jev'
      ? createJevDecision({ endpoint: 'http://localhost/jev', fetch, timeoutMs })
      : createOllamaDecision({ endpoint: 'http://localhost', model: 'm', fetch, timeoutMs });
    it('marks only the rejected batch missing and continues subsequent requests', async () => {
      let rejectNext = false;
      const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
        if (rejectNext && !String(url).endsWith('/tags')) {
          rejectNext = false;
          return new Response(JSON.stringify({ detail: 'input exceeds 2560 tokens' }), { status: 422 });
        }
        return success(String(url), init);
      });
      const backend = create(fetch);
      await backend.identity();
      rejectNext = true;
      const batchSize = backendName === 'jev' ? 16 : 1;
      const requests = Array.from({ length: batchSize + 1 }, (_, i) => ({ ...request, key: `q${i}` }));
      const results = await backend.score(requests);
      expect(results).toHaveLength(requests.length);
      expect(results.slice(0, batchSize)).toEqual(requests.slice(0, batchSize).map(({ key }) => ({ key,
        status: 'missing', probabilities: null, reason: 'Decision HTTP 422: input exceeds 2560 tokens' })));
      expect(results.at(-1)).toMatchObject({ key: `q${batchSize}`, status: 'ok' });
    });
    it.each([400, 422, 499])('throws HTTP %i from identity probes', async status => {
      const backend = create(async () => new Response('{"detail":"identity rejected"}', { status }));
      await expect(backend.identity()).rejects.toThrow(`Decision HTTP ${status}: identity rejected`);
    });
    it.each([500, 503])('throws HTTP %i from scoring requests', async status => {
      let scoring = false;
      const backend = create(async (url, init) => scoring && !String(url).endsWith('/tags')
        ? new Response('{"detail":"unavailable"}', { status }) : success(String(url), init));
      await backend.identity(); scoring = true;
      await expect(backend.score([request])).rejects.toThrow(`Decision HTTP ${status}`);
    });
    it('propagates scoring connection errors', async () => {
      let scoring = false;
      const backend = create(async (url, init) => {
        if (scoring && !String(url).endsWith('/tags')) throw new TypeError('connection lost');
        return success(String(url), init);
      });
      await backend.identity(); scoring = true;
      await expect(backend.score([request])).rejects.toThrow('connection lost');
    });
    it.each(['timeout', 'abort'] as const)('throws on scoring %s instead of marking missing', async mode => {
      let scoring = false;
      const controller = new AbortController();
      const backend = create(async (url, init) => {
        if (!scoring || String(url).endsWith('/tags')) return success(String(url), init);
        return await new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('fetch aborted')), { once: true });
          if (mode === 'abort') controller.abort();
        });
      }, 10);
      await backend.identity(); scoring = true;
      await expect(backend.score([request], controller.signal)).rejects.toThrow(mode === 'timeout' ? 'timed out' : 'cancelled');
    });
  });
}
