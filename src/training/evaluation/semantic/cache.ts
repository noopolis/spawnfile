import { createHash } from 'node:crypto';
import type { CachedJudgment, JudgeCache } from '../../contracts/evaluation.js';

/** Invocation-local LRU. A hit is reused evidence, never another inference or trial. */
export function createJudgeCache({ maxEntries }: { maxEntries: number }): JudgeCache {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10000) throw new Error('Invalid judge cache entry bound');
  const entries = new Map<string, CachedJudgment>();
  let bytes = 0;
  const size = (key: string, value: CachedJudgment) => Buffer.byteLength(key + value.response + value.sourceCallId);
  return {
    get(key) {
      const found = entries.get(key);
      if (!found) return undefined;
      entries.delete(key); entries.set(key, found);
      return structuredClone(found);
    },
    put(key, value) {
      const old = entries.get(key);
      if (old) bytes -= size(key, old);
      entries.delete(key);
      const length = size(key, value);
      if (length > 32 * 1024 * 1024) return;
      entries.set(key, structuredClone(value));
      bytes += length;
      while (entries.size > maxEntries || bytes > 32 * 1024 * 1024) {
        const first = entries.keys().next().value!;
        bytes -= size(first, entries.get(first)!);
        entries.delete(first);
      }
    },
  };
}

export function judgmentCacheKey(identity: string, system: string, prompt: string, minimum: number): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(['paideia.judgment-cache.v1', identity, system, prompt, minimum])).digest('hex')}`;
}
