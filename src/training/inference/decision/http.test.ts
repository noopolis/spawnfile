import { afterEach, expect, it, vi } from 'vitest';
import { decisionHttp } from './http.js';

afterEach(() => vi.unstubAllGlobals());
it('validates endpoints and timeouts; supports default fetch and HTTP GET', async () => {
  for (const endpoint of ['file:///a', 'http://user:secret@localhost', 'http://localhost?q=1', 'http://localhost#f']) expect(() => decisionHttp({ endpoint })).toThrow(/endpoint/);
  for (const timeoutMs of [0, -1, 0.1, Infinity, 2147483648]) expect(() => decisionHttp({ endpoint: 'http://localhost', timeoutMs })).toThrow(/timeout/);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  expect(await decisionHttp({ endpoint: 'https://localhost' }).json('https://localhost')).toEqual({});
  expect(fetch.mock.calls[0]![1]!.method).toBe('GET');
});
it('reports HTTP and JSON failures', async () => {
  await expect(decisionHttp({ endpoint: 'http://localhost', fetch: async () => new Response('', { status: 503 }) }).json('http://localhost')).rejects.toThrow('Decision HTTP 503');
  await expect(decisionHttp({ endpoint: 'http://localhost', fetch: async () => new Response('invalid') }).json('http://localhost')).rejects.toThrow();
});
it('times out response bodies and handles explicit cancellation', async () => {
  const slow: typeof fetch = async (_url, init) => Object.assign(new Response('{}'), { json: async () => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(Error('abort')), { once: true });
  }) });
  await expect(decisionHttp({ endpoint: 'http://localhost', timeoutMs: 5, fetch: slow }).json('http://localhost', {})).rejects.toThrow(/timed out/);
  const controller = new AbortController();
  const promise = decisionHttp({ endpoint: 'http://localhost', fetch: slow }).json('http://localhost', {}, controller.signal);
  await Promise.resolve(); controller.abort();
  await expect(promise).rejects.toThrow(/cancelled/);
});
