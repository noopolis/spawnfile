import { afterEach, expect, test } from 'vitest';
import { bindBootedJudges, bindBootedJudgmentCache, createBootedJudgeInference, type BootedJudgmentCache } from './judge.js';

const clean = '{"type":"response_item","payload":{"type":"message","role":"assistant"}}';
const schema = { type: 'object', properties: { score: { type: 'integer' } }, required: ['score'], additionalProperties: false };

/** A judge that answers a new score every wake, and an in-memory cache with the store's occurrence rule. */
const setup = () => {
  let wakes = 0;
  bindBootedJudges({ judge: async () => ({ wake: async () => ({ state: 'completed', acceptanceId: 'a', executionId: 'e', code: null,
    text: `{"score":${++wakes}}`, usage: [], transcript: clean }) }) });
  const stored = new Map<string, string>();
  const seen = new Map<string, number>();
  const cache: BootedJudgmentCache = {
    take: async (key) => { const occurrence = seen.get(key) ?? 0; seen.set(key, occurrence + 1); const reply = stored.get(`${key}/${occurrence}`); return reply === undefined ? { occurrence } : { occurrence, reply }; },
    put: async (key, occurrence, reply) => { stored.set(`${key}/${occurrence}`, reply); }
  };
  bindBootedJudgmentCache(cache);
  return { wakes: () => wakes, restart: () => seen.clear() };
};

afterEach(() => { bindBootedJudges(undefined); bindBootedJudgmentCache(undefined); });

test('a later run reads the same judgment for the same article and bank, and asks again when either changes', async () => {
  const { wakes, restart } = setup();
  const judge = createBootedJudgeInference({ engine: 'codex', effort: 'medium', cacheable: true });
  const ask = (prompt: string) => judge.generate({ prompt, model: 'gpt-6-astra', responseSchema: schema });
  const first = await ask('article A; questions v1');
  restart();
  const again = await ask('article A; questions v1');
  expect(again).toEqual({ ...first, usage: null });
  expect(wakes()).toBe(1);
  await ask('article A; questions v2');
  await ask('article B; questions v1');
  expect(wakes()).toBe(3);
});

test('keeps repeated identical requests as separate samples, and never caches an optimizer route', async () => {
  const { wakes, restart } = setup();
  const judge = createBootedJudgeInference({ engine: 'codex', cacheable: true });
  const ask = () => judge.generate({ prompt: 'same', model: 'm', responseSchema: schema });
  const [one, two] = [await ask(), await ask()];
  expect(one.text).not.toBe(two.text);
  restart();
  expect([(await ask()).text, (await ask()).text]).toEqual([one.text, two.text]);
  expect(wakes()).toBe(2);
  const optimizer = createBootedJudgeInference({ engine: 'codex' });
  await optimizer.generate({ prompt: 'same', model: 'm', responseSchema: schema });
  expect(wakes()).toBe(3);
});
