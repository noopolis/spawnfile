import { expect, it, vi } from 'vitest';
import { createOllamaInference } from './provider.js';
const answer = { done: true, model: 'local', message: { content: 'ok' } };
it('verifies supported version once and sends context with truncation and shifting disabled', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async url => new Response(JSON.stringify(String(url).endsWith('/api/version') ? { version: '0.34.0' } : answer)));
  const provider = createOllamaInference({ baseUrl: 'http://localhost/prefix', contextWindowTokens: 8192, fetch });
  await provider.generate({ prompt: 'one', model: 'local' }); await provider.generate({ prompt: 'two', model: 'local' });
  expect(fetch).toHaveBeenCalledTimes(3); expect(String(fetch.mock.calls[0]![0])).toBe('http://localhost/prefix/api/version');
  expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toMatchObject({ truncate: false, shift: false, options: { num_ctx: 8192 } });
});
it.each(['0.33.9', 'not-version', undefined, '0.34.0-rc1'])('refuses unverified server %s before generation', async version => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ version })));
  await expect(createOllamaInference({ baseUrl: 'http://localhost', contextWindowTokens: 8192, fetch }).generate({ prompt: 'p', model: 'm' }))
    .rejects.toMatchObject({ kind: 'unsupported' });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([401, 403, 500])('retains classified version preflight HTTP %s', async status => {
  await expect(createOllamaInference({ baseUrl: 'http://localhost', contextWindowTokens: 8192,
    fetch: async () => new Response('{}', { status }) }).generate({ prompt: 'p', model: 'm' }))
    .rejects.toMatchObject({ kind: status < 500 ? 'authentication' : 'unavailable' });
});
it('bounds version discovery and generation by the same deadline, rejects bad context and cloud', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener('abort', () => reject(Error('aborted')), { once: true });
  }));
  await expect(createOllamaInference({ baseUrl: 'http://localhost', contextWindowTokens: 8192, fetch, timeoutMs: 10 })
    .generate({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ kind: 'timeout' });
  expect(fetch).toHaveBeenCalledTimes(1);
  for (const value of [0, 1.5, 1048577]) expect(() => createOllamaInference({ baseUrl: 'http://localhost', contextWindowTokens: value })).toThrow('controls');
  await expect(createOllamaInference({ baseUrl: 'https://ollama.com', contextWindowTokens: 8192, fetch })
    .generate({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ kind: 'unsupported' });
  const future = vi.fn<typeof globalThis.fetch>(async url => new Response(JSON.stringify(String(url).endsWith('/api/version') ? { version: '1.0.0' } : answer)));
  expect((await createOllamaInference({ baseUrl: 'http://localhost', contextWindowTokens: 8192, fetch: future })
    .generate({ prompt: 'p', model: 'm' })).text).toBe('ok');
});

it('classifies malformed version JSON as protocol and preserves cancellation during its body read', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('not JSON'));
  await expect(createOllamaInference({ baseUrl: 'http://localhost', contextWindowTokens: 8192, fetch })
    .generate({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ kind: 'protocol' });
  expect(fetch).toHaveBeenCalledTimes(1);
  const controller = new AbortController();
  const aborting = async () => Object.assign(new Response('{}'), { json: async () => { controller.abort(); throw Error('aborted'); } });
  await expect(createOllamaInference({ baseUrl: 'http://localhost', contextWindowTokens: 8192, fetch: aborting })
    .generate({ prompt: 'p', model: 'm', signal: controller.signal })).rejects.toMatchObject({ kind: 'cancelled' });
});
