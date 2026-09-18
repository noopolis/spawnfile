import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { grokLaunchFrom } from './grok-fixtures.js';
import { readSealedBrokerUsage } from './sealed-usage.js';
import { launchFixture } from './test-fixtures.js';
import type { GrokNativeLaunch, VerifiedNativeLaunch } from './receipt/index.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const grok = async (): Promise<{ launch: VerifiedNativeLaunch & GrokNativeLaunch; ledger: string; codex: VerifiedNativeLaunch }> => {
  const codex = await launchFixture();
  roots.push(codex.root);
  const plain = JSON.parse(JSON.stringify(codex.launch)) as VerifiedNativeLaunch;
  const launch = await grokLaunchFrom(codex.launch, codex.root);
  return { launch, ledger: launch.broker.usageLedgerPath, codex: plain };
};

/** One sealed `noopolis.daimon.turn-usage.v1` row exactly as the broker appends it for a failed turn. */
const row = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  v: 'noopolis.daimon.turn-usage.v1', agent: 'agent:writer', wake: 'wake-1', engine: 'grok', at: '2026-09-18T00:28:21.000Z',
  input: 5136, output: 158, cache_read: 256, cache_write: 0, total: 5550, calls: 2, notional_usd: 0.02, complete: false,
  outcome: 'failed', reason: 'unknown', turn: 'a'.repeat(64), limit_reason: 'none', model: 'grok-4.6', ...overrides,
}) + '\n';

const write = async (file: string, text: string): Promise<void> => { await mkdir(dirname(file), { recursive: true, mode: 0o700 }); await writeFile(file, text, { mode: 0o600 }); };
const once = { attempts: 1, intervalMs: 0 };

describe('readSealedBrokerUsage', () => {
  it('reports the spend the broker sealed when no terminal frame arrived', async () => {
    const { launch, ledger } = await grok();
    await write(ledger, row());
    // Called the way the adapter calls it, on its own default bound.
    const sealed = await readSealedBrokerUsage(launch);
    expect(sealed.rows).toHaveLength(1);
    // Grok buckets are disjoint; inputTokens counts every prompt-side token.
    expect(sealed.usage).toMatchObject({ inputTokens: 5392, cachedInputTokens: 256, cacheWriteInputTokens: 0, outputTokens: 158, notionalUsd: 0.02 });
  });

  it('sums every sealed turn and collapses a replayed turn to one', async () => {
    const { launch, ledger } = await grok();
    await write(ledger, row() + row() + row({ turn: 'b'.repeat(64), wake: 'wake-2', output: 42, total: 5434 }));
    const sealed = await readSealedBrokerUsage(launch, once);
    expect(sealed.rows).toHaveLength(2);
    expect(sealed.usage?.outputTokens).toBe(200);
  });

  it('reports absence, never a zero, for a ledger it could not read', async () => {
    const { launch, ledger } = await grok();
    // A fabricated zero is byte-identical to a measured one, so each of these
    // must come back null rather than a row of zeroes.
    expect((await readSealedBrokerUsage(launch, once)).usage).toBeNull();
    await write(ledger, '');
    expect((await readSealedBrokerUsage(launch, once)).usage).toBeNull();
    await write(ledger, '{ not json\n');
    expect((await readSealedBrokerUsage(launch, once)).usage).toBeNull();
    await write(ledger, row({ engine: 'codex' }));
    expect((await readSealedBrokerUsage(launch, once)).usage).toBeNull();
    await write(ledger, row({ total: 1 }));
    expect((await readSealedBrokerUsage(launch, once)).usage).toBeNull();
    // Differing rows under one turn key are a contradiction, not a replay.
    await write(ledger, row() + row({ output: 999 }));
    expect((await readSealedBrokerUsage(launch, once)).usage).toBeNull();
  });

  it('has nothing to recover for a launch with no broker', async () => {
    const { codex, ledger } = await grok();
    await write(ledger, row());
    expect(await readSealedBrokerUsage(codex, once)).toEqual({ usage: null, rows: [] });
  });

  it('waits a bounded moment for the broker to seal, then gives up without inventing a number', async () => {
    const { launch, ledger } = await grok();
    // Sealing is the broker's reaction to losing its client, so the append can
    // land just after the worker dies; one immediate read would race it.
    setTimeout(() => { void write(ledger, row()); }, 30);
    expect((await readSealedBrokerUsage(launch, { attempts: 40, intervalMs: 10 })).usage?.outputTokens).toBe(158);
    await rm(ledger, { force: true });
    expect((await readSealedBrokerUsage(launch, { attempts: 3, intervalMs: 1 })).usage).toBeNull();
    expect((await readSealedBrokerUsage(launch, { attempts: 0, intervalMs: 1 })).usage).toBeNull();
    expect((await readSealedBrokerUsage(launch, { attempts: 1, intervalMs: -1 })).usage).toBeNull();
  });
});
