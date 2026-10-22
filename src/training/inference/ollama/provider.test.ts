import { expect, it, vi } from 'vitest';
import { createOllamaInference } from './provider.js';
const body = { done: true, model: 'actual:tag', message: { content: 'answer', thinking: 'never output' }, prompt_eval_count: 10, eval_count: 2 };
const respond = (data: unknown, status = 200) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify(data), { status }));
it('uses native final text, actual model and honest usage with explicit controls', async () => {
  const fetch = respond(body);
  const result = await createOllamaInference({ baseUrl: 'http://localhost:11434', fetch }).generate({ prompt: 'p', system: 's', model: 'requested', temperature: 0, seed: 2 });
  expect(result).toMatchObject({ text: 'answer', model: 'actual:tag', usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: null } });
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({ model: 'requested', stream: false, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'p' }], options: { temperature: 0, seed: 2 } });
});
it.each([[429, 'quota'], [503, 'unavailable'], [404, 'unavailable'], [401, 'authentication'], [403, 'authentication'], [400, 'protocol']])('classifies HTTP %s', async (status, kind) => {
  await expect(createOllamaInference({ baseUrl: 'http://localhost', fetch: respond({}, status as number) }).generate({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ kind });
});
it('rejects malformed, unfinished, empty and tool responses', async () => {
  for (const raw of [null, {}, { ...body, done: false }, { ...body, model: '' }, { ...body, message: { content: '', thinking: 'secret' } }, { ...body, message: { content: 'x', tool_calls: [{}] } }]) {
    await expect(createOllamaInference({ baseUrl: 'http://localhost', fetch: respond(raw) }).generate({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ kind: 'protocol' });
  }
  await expect(createOllamaInference({ baseUrl: 'http://localhost', fetch: async () => new Response('broken') }).generate({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ kind: 'protocol' });
  const result = await createOllamaInference({ baseUrl: 'http://localhost', fetch: respond({ ...body, prompt_eval_count: -1, eval_count: 'unknown' }) }).generate({ prompt: 'p', model: 'm' });
  expect(result.usage?.inputTokens).toBeNull(); expect(result.usage?.outputTokens).toBeNull();
});
it('rejects invalid endpoint and controls, handles transport and cancellation', async () => {
  for (const baseUrl of ['file:///a', 'http://user:pass@localhost', 'http://localhost?key=secret']) expect(() => createOllamaInference({ baseUrl })).toThrow();
  expect(() => createOllamaInference({ baseUrl: 'http://localhost', timeoutMs: 0 })).toThrow();
  const provider = createOllamaInference({ baseUrl: 'http://localhost', fetch: async () => { throw Error('private'); } });
  for (const patch of [{ prompt: '' }, { model: '' }, { model: '-x' }, { temperature: -1 }, { seed: 0.5 }]) await expect(provider.generate({ prompt: 'p', model: 'm', ...patch })).rejects.toMatchObject({ kind: 'unsupported' });
  await expect(provider.generate({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ kind: 'transport' });
  await expect(provider.generate({ prompt: 'p', model: 'm', signal: AbortSignal.abort() })).rejects.toMatchObject({ kind: 'cancelled' });
});
it('rejects truncation and classifies interrupted response bodies', async () => {
  await expect(createOllamaInference({ baseUrl: 'http://localhost', fetch: respond({ ...body, done_reason: 'length' }) })
    .generate({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ kind: 'protocol',responseModel:'actual:tag',responseRoute:'ollama:http://localhost/',
      usage:{inputTokens:10,outputTokens:2,cachedInputTokens:null,reasoningTokens:null} });
  const controller = new AbortController();
  const interrupted = async () => Object.assign(new Response('{}'), { json: async () => { controller.abort(); throw Error('cancelled'); } });
  await expect(createOllamaInference({ baseUrl: 'http://localhost', fetch: interrupted })
    .generate({ prompt: 'p', model: 'm', signal: controller.signal })).rejects.toMatchObject({ kind: 'cancelled' });
  const slow = async (_url: unknown, init?: RequestInit) => Object.assign(new Response('{}'), { json: async () => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(Error('timeout')), { once: true });
  }) });
  await expect(createOllamaInference({ baseUrl: 'http://localhost', timeoutMs: 10, fetch: slow })
    .generate({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ kind: 'timeout' });
});

const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
it('sends the native format schema, preserves exact JSON text and validates independently', async () => {
  const text = '{ "answer": "grounded\\ntext" }'; const fetch = respond({ ...body, message: { content: text } });
  const result = await createOllamaInference({ baseUrl: 'http://localhost', fetch }).generate({ prompt: 'p', model: 'm', responseSchema: schema });
  expect(result.text).toBe(text); expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 2 });
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).format).toEqual(schema);
});
it('refuses malformed schemas and known unsupported Cloud routes before network work', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw Error('must not fetch'); });
  for (const responseSchema of [{ type: 'invalid' }, { type: 'object', unknownKeyword: true }]) {
    await expect(createOllamaInference({ baseUrl: 'http://localhost', fetch }).generate({ prompt: 'p', model: 'm', responseSchema }))
      .rejects.toMatchObject({ kind: 'unsupported' });
  }
  for (const [baseUrl, model] of [['https://ollama.com', 'm'], ['https://api.ollama.com', 'm'], ['http://localhost', 'gpt-oss:120b-cloud']]) {
    await expect(createOllamaInference({ baseUrl: baseUrl!, fetch }).generate({ prompt: 'p', model: model!, responseSchema: schema }))
      .rejects.toMatchObject({ kind: 'unsupported' });
  }
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['prose {"answer":"x"}', '{}', '{"answer":5}', '{"answer":"x","extra":1}', '{"answer":"x","answer":"y"}'])('rejects schema output failure while retaining measured tokens (%s)', async content => {
  await expect(createOllamaInference({ baseUrl: 'http://localhost', fetch: respond({ ...body, message: { content } }) })
    .generate({ prompt: 'p', model: 'm', responseSchema: schema })).rejects.toMatchObject({ kind: 'invalid-response', responseModel: 'actual:tag',
      responseRoute: 'ollama:http://localhost/', usage: { inputTokens: 10, outputTokens: 2 } });
});
it('does not revalidate against a caller-mutated schema and reports server rejection as unsupported', async () => {
  const mutable = structuredClone(schema);
  const fetch: typeof globalThis.fetch = async () => { mutable.properties.answer.type = 'number'; return new Response(JSON.stringify({ ...body, message: { content: '{"answer":"text"}' } })); };
  expect((await createOllamaInference({ baseUrl: 'http://localhost', fetch }).generate({ prompt: 'p', model: 'm', responseSchema: mutable })).text).toBe('{"answer":"text"}');
  await expect(createOllamaInference({ baseUrl: 'http://localhost', fetch: respond({}, 400) }).generate({ prompt: 'p', model: 'm', responseSchema: schema }))
    .rejects.toMatchObject({ kind: 'unsupported' });
});
