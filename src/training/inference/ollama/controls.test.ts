import { expect, it, vi } from 'vitest';
import { createOllamaInference } from './provider.js';
const body = { done: true, model: 'qwen3:4b', message: { content: 'ok' }, prompt_eval_count: 12, eval_count: 3 };
it('sends native think, keep_alive and num_predict without an extra warmup request', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(body)));
  const options = { baseUrl: 'http://localhost', think: false, keepAliveSeconds: 300, maxOutputTokens: 256, fetch };
  const provider = createOllamaInference(options); options.think = true;
  await provider.generate({ model: 'qwen3:4b', prompt: 'one' });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({ think: false, keep_alive: '300s', options: { num_predict: 256 } });
  await createOllamaInference({ ...options, keepAliveSeconds: 0 }).generate({ model: 'qwen3:4b', prompt: 'two' });
  expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string).keep_alive).toBe('0s');
});
it('rejects invalid options and known unsupported thinking models before fetch', async () => {
  const fetch = vi.fn();
  for (const patch of [{ think: 'false' }, { keepAliveSeconds: -1 }, { keepAliveSeconds: 1.5 }, { keepAliveSeconds: 86401 },
    { maxOutputTokens: 0 }, { maxOutputTokens: 131073 }, { maxOutputTokens: NaN }]) {
    expect(() => createOllamaInference({ baseUrl: 'http://localhost', fetch, ...patch } as never)).toThrow('controls');
  }
  for (const model of ['gpt-oss:20b', 'library/gpt-oss']) await expect(createOllamaInference({ baseUrl: 'http://localhost', fetch, think: false })
    .generate({ model, prompt: 'p' })).rejects.toMatchObject({ kind: 'unsupported' });
  expect(fetch).not.toHaveBeenCalled();
});
it('rejects server-disobeyed thinking and output truncation while retaining measured usage', async () => {
  for (const response of [{ ...body, message: { content: 'ok', thinking: 'hidden' } }, { ...body, done_reason: 'length' }]) {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(response)));
    await expect(createOllamaInference({ baseUrl: 'http://localhost', fetch, think: false, maxOutputTokens: 2 }).generate({ model: 'local', prompt: 'p' }))
      .rejects.toMatchObject({ usage: { inputTokens: 12, outputTokens: 3 }, responseModel: 'qwen3:4b' });
  }
  await expect(createOllamaInference({ baseUrl: 'http://localhost', think: false, fetch: async () => new Response('{}', { status: 400 }) })
    .generate({ model: 'local', prompt: 'p' })).rejects.toMatchObject({ kind: 'unsupported' });
});

it('rejects known cloud routes for every authored native control before fetch', async () => {
  const fetch = vi.fn();
  for (const control of [{ think: false }, { keepAliveSeconds: 300 }, { maxOutputTokens: 256 }]) {
    for (const [baseUrl, model] of [['https://ollama.com', 'local'], ['http://localhost', 'remote-cloud']]) {
      await expect(createOllamaInference({ baseUrl: baseUrl!, fetch, ...control }).generate({ model: model!, prompt: 'p' }))
        .rejects.toMatchObject({ kind: 'unsupported' });
    }
  }
  expect(fetch).not.toHaveBeenCalled();
});
