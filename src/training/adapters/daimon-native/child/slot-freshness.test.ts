import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGrokSlotFreshnessStore } from './slot-freshness.js';

it('mints a fresh nonce per recycle request and persists the accepted generation floor across processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-slot-freshness-'));
  try {
    const file = join(root, 'slots.json');
    expect(() => createGrokSlotFreshnessStore('relative.json')).toThrow('absolute');
    const store = createGrokSlotFreshnessStore(file);
    await expect(store.request(-1)).rejects.toThrow('slot');
    await expect(store.accept(0, { nonce: 'a'.repeat(64), generation: 1 })).rejects.toThrow('stale: nonce');
    const [first, other] = await Promise.all([store.request(0), store.request(7)]);
    expect(first.minGeneration).toBe(1); expect(first.expectedNonce).toMatch(/^[a-f0-9]{64}$/u);
    expect(((await stat(file)).mode & 0o777)).toBe(0o600);
    const reopened = createGrokSlotFreshnessStore(file);
    await expect(reopened.accept(0, { nonce: other.expectedNonce, generation: 1 })).rejects.toThrow('stale: nonce');
    await expect(reopened.accept(0, { nonce: first.expectedNonce, generation: 0 })).rejects.toThrow('stale: generation');
    await reopened.accept(0, { nonce: first.expectedNonce, generation: 4 });
    await expect(reopened.accept(0, { nonce: first.expectedNonce, generation: 5 })).rejects.toThrow('stale: nonce');
    const second = await store.request(0);
    expect(second.minGeneration).toBe(5); expect(second.expectedNonce).not.toBe(first.expectedNonce);
    await expect(store.accept(0, { nonce: second.expectedNonce, generation: 4 })).rejects.toThrow('stale: generation');
    await store.accept(7, { nonce: other.expectedNonce, generation: 1 });
    expect(JSON.parse(await readFile(file, 'utf8')).slots).toEqual({ 0: { lastGeneration: 4, pendingNonce: second.expectedNonce }, 7: { lastGeneration: 1 } });
    await writeFile(file, '{"schema":"other"}');
    await expect(store.request(0)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
