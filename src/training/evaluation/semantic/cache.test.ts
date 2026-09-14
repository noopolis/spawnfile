import { expect, it } from 'vitest';
import { createJudgeCache, judgmentCacheKey } from './cache.js';

it('bounds entries with LRU access and isolates caller mutations', () => {
  const cache = createJudgeCache({ maxEntries: 2 });
  const entry = { response: 'valid', sourceCallId: 'one' };
  cache.put('a', entry); entry.response = 'changed';
  cache.put('b', { response: 'two', sourceCallId: 'two' });
  cache.get('a')!.response = 'mutated';
  cache.put('c', { response: 'three', sourceCallId: 'three' });
  expect(cache.get('b')).toBeUndefined();
  expect(cache.get('a')!.response).toBe('valid');
  cache.put('a', { response: 'replacement', sourceCallId: 'four' });
  expect(cache.get('a')!.response).toBe('replacement');
});
it.each([0, -1, 10001, 1.5, NaN])('rejects invalid bounds %s', maxEntries => {
  expect(() => createJudgeCache({ maxEntries })).toThrow('bound');
});
it('bounds bytes even with few entries and does not store an oversized response', () => {
  const cache = createJudgeCache({ maxEntries: 10 });
  const large = 'x'.repeat(17 * 1024 * 1024);
  cache.put('a', { response: large, sourceCallId: 'a' });
  cache.put('b', { response: large, sourceCallId: 'b' });
  expect(cache.get('a')).toBeUndefined();
  expect(cache.get('b')).toBeDefined();
  cache.put('b', { response: large + large, sourceCallId: 'b' });
  expect(cache.get('b')).toBeUndefined();
});
it('invalidates independently on policy, protocol, rendered input or threshold change', () => {
  const base = ['policy', 'system', 'prompt', 0.8] as const;
  const key = judgmentCacheKey(...base);
  expect(judgmentCacheKey(...base)).toBe(key);
  expect(judgmentCacheKey('other', base[1], base[2], base[3])).not.toBe(key);
  expect(judgmentCacheKey(base[0], 'other', base[2], base[3])).not.toBe(key);
  expect(judgmentCacheKey(base[0], base[1], 'other', base[3])).not.toBe(key);
  expect(judgmentCacheKey(base[0], base[1], base[2], 0.9)).not.toBe(key);
});
