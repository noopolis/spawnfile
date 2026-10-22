import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertNoFloorRollback, createGrokSlotFreshnessStore } from './slot-freshness.js';

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

it('never rolls a generation floor back when two stores interleave on one file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-slot-race-'));
  try {
    const file = join(root, 'slots.json');
    const a = createGrokSlotFreshnessStore(file), b = createGrokSlotFreshnessStore(file);
    let floor = 0, accepted = 0;
    for (let generation = 10; generation < 40; generation++) {
      const { expectedNonce } = await a.request(0);
      // Lock order decides whether B's request supersedes A's nonce; either way no floor is ever erased.
      const [acceptance, stale] = await Promise.allSettled([a.accept(0, { nonce: expectedNonce, generation }), b.request(0)]);
      expect(stale.status).toBe('fulfilled');
      if (acceptance.status === 'fulfilled') { floor = generation; accepted++; }
      else expect(String(acceptance.reason)).toContain('stale: nonce');
      expect(JSON.parse(await readFile(file, 'utf8')).slots[0].lastGeneration).toBe(floor);
      const next = await b.request(0);
      expect(next.minGeneration).toBe(floor + 1);
      if (floor) await expect(a.accept(0, { nonce: next.expectedNonce, generation: floor })).rejects.toThrow('stale: generation');
    }
    expect(accepted).toBeGreaterThan(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('refuses symlinked state, reclaims a dead owner lock and times out behind a live one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-slot-lock-'));
  try {
    const file = join(root, 'slots.json');
    const target = join(root, 'elsewhere.json');
    await writeFile(target, JSON.stringify({ schema: 'paideia.daimon-native.grok-slot-freshness.v1', slots: {} }));
    await symlink(target, file);
    await expect(createGrokSlotFreshnessStore(file).request(0)).rejects.toThrow('never a symlink');
    await rm(file);
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    await writeFile(`${file}.lock`, JSON.stringify({ pid: Number(dead.stdout), token: 'dead-owner' }));
    expect((await createGrokSlotFreshnessStore(file).request(0)).minGeneration).toBe(1);
    await expect(stat(`${file}.lock`)).rejects.toThrow();
    await writeFile(`${file}.lock`, JSON.stringify({ pid: process.pid, token: 'live-owner' }));
    await expect(createGrokSlotFreshnessStore(file, { lockTimeoutMs: 50 }).request(0)).rejects.toThrow('live evaluator');
    await writeFile(`${file}.lock`, 'torn');
    await expect(createGrokSlotFreshnessStore(file, { lockTimeoutMs: 50 }).request(0)).rejects.toThrow('live evaluator');
    await rm(`${file}.lock`);
    await rm(file); await writeFile(target, 'x'); await link(target, file);
    await expect(createGrokSlotFreshnessStore(file).request(0)).rejects.toThrow('never a symlink');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('compare-and-swap refuses lowering or dropping a floor and surfaces non-contention lock errors', async () => {
  const disk = { slots: { 0: { lastGeneration: 10 }, 3: { lastGeneration: 1 } } };
  expect(() => assertNoFloorRollback(disk, { slots: { 0: { lastGeneration: 11 }, 3: { lastGeneration: 1 } } })).not.toThrow();
  expect(() => assertNoFloorRollback(disk, { slots: { 0: { lastGeneration: 9 }, 3: { lastGeneration: 1 } } })).toThrow('lower a generation floor');
  expect(() => assertNoFloorRollback(disk, { slots: { 0: { lastGeneration: 10 } } })).toThrow('lower a generation floor');
  await expect(createGrokSlotFreshnessStore(join(tmpdir(), `missing-${Date.now()}`, 'slots.json')).request(0)).rejects.toThrow('ENOENT');
});
