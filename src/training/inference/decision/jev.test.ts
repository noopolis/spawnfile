import { expect, it, vi } from 'vitest';
import type { DecisionRequest } from '../../contracts/grading.js';
import { createJevDecision } from './index.js';

const request: DecisionRequest = { key: 'q', type: 'yes-no', optionLabels: ['yes', 'no'], instructions: 'Question?', projection: { text: 'shared' } };
const options = { endpoint: 'http://localhost/v1/systemone' };
it('pins identity via a fixed probe, batches at 16, and maps Jev booleans', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(init!.body as string) as { questions: Record<string, unknown> };
    return new Response(JSON.stringify({ model: 'jev-model', answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { probabilities: { true: 0.9, false: 0.1 } }])) }));
  });
  const backend = createJevDecision({ ...options, fetch });
  expect(await backend.identity()).toEqual({ backend: 'jev-http', model: 'jev-model' });
  await backend.identity(); expect(fetch).toHaveBeenCalledTimes(1);
  const results = await backend.score(Array.from({ length: 33 }, (_, i) => ({ ...request, key: `q${i}` })));
  expect(results).toHaveLength(33);
  expect(results[0]).toEqual({ key: 'q0', status: 'ok', probabilities: { yes: 0.9, no: 0.1 } });
  const bodies = fetch.mock.calls.map(call => JSON.parse(call[1]!.body as string));
  expect(bodies.map(body => Object.keys(body.questions).length)).toEqual([1, 16, 16, 1]);
  expect(bodies[0].state).toBe('{}');
  expect(bodies[1].state).toBe(JSON.stringify(request.projection));
  expect(bodies[1].questions.q0).toEqual({ type: 'noul', instructions: 'Question?', criteria: { true: 'yes', false: 'no' } });
});
it('shares only identical projections and restores caller order; maps ordinal score positions', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(init!.body as string) as { questions: Record<string, { type: string }> };
    return new Response(JSON.stringify({ model: 'm', answers: Object.fromEntries(Object.entries(body.questions).map(([key, q]) => [key,
      { probabilities: q.type === 'score' ? { 0: 0.3, 1: 0.7 } : { a: 0.8, b: 0.2 } }])) }));
  });
  const backend = createJevDecision({ ...options, fetch });
  const first: DecisionRequest = { ...request, type: 'choice', optionLabels: ['a', 'b'], system: 'criteria' };
  const results = await backend.score([first, { ...request, key: 'rating', type: 'score', optionLabels: [4, 5], projection: { private: 'other' } }, { ...first, key: 'third' }]);
  expect(results.map(result => result.key)).toEqual(['q', 'rating', 'third']);
  expect(results[1]!.probabilities).toEqual({ 4: 0.3, 5: 0.7 });
  const bodies = fetch.mock.calls.map(call => JSON.parse(call[1]!.body as string));
  expect(bodies).toHaveLength(2);
  expect(bodies[0].questions.q.instructions).toBe('criteria\nQuestion?');
  expect(bodies[1].questions.rating.criteria).toEqual(['Score 4', 'Score 5']);
  expect(await backend.identity()).toEqual({ backend: 'jev-http', model: 'm' });
  expect(await backend.score([])).toEqual([]);
});
it('refuses missing probabilities/options or invalid distributions without renormalizing', async () => {
  for (const probabilities of [undefined, null, {}, { true: 1 }, { true: 0.8, false: -0.1 }, { true: 2, false: 0 }, { true: '0.8', false: 0.2 }, { true: 0.3, false: 0.3 }]) {
    const backend = createJevDecision({ ...options, fetch: async () => new Response(JSON.stringify({ model: 'm', answers: { q: { probabilities } } })) });
    expect((await backend.score([request]))[0]).toMatchObject({ status: 'missing', probabilities: null });
  }
  const backend = createJevDecision({ ...options, fetch: async () => new Response('{"model":"m"}') });
  expect((await backend.score([request]))[0]!.status).toBe('missing');
});
it('refuses missing identity and model changes', async () => {
  for (const body of [null, {}, { model: '' }, { model: 12 }]) await expect(createJevDecision({ ...options, fetch: async () => new Response(JSON.stringify(body)) }).identity()).rejects.toThrow(/model/);
  let model = 'first';
  const backend = createJevDecision({ ...options, fetch: async () => new Response(JSON.stringify({ model })) });
  await backend.identity(); model = 'second';
  await expect(backend.score([request])).rejects.toThrow(/model changed/);
});
