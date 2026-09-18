import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { grokLaunchFrom } from './grok-fixtures.js';
import { BROKER_REQUESTS_SCHEMA, readSealedBrokerRequests, readSealedBrokerUsage } from './sealed-usage.js';
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

/** One `noopolis.daimon.turn-requests.v1` row exactly as the broker's proxy appends it. */
const requestRow = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  v: 'noopolis.daimon.turn-requests.v1', agent: 'agent:writer', wake: 'wake-1', engine: 'grok', at: '2026-09-18T00:28:21.000Z',
  turn: 'a'.repeat(64), model: 'grok-4.6', request: 0, requests: 1, input: 5392, cached_input: 256, fresh_input: 5136,
  cache_write: 0, output: 158, total: 5550, usage_source: 'stream',
  started_at: '2026-09-18T00:28:19.000Z', ended_at: '2026-09-18T00:28:21.000Z', ...overrides,
}) + '\n';
/** The broker writes both streams into one slot ledger directory. */
const requestsFile = (ledger: string): string => join(dirname(ledger), 'requests.jsonl');

describe('readSealedBrokerRequests', () => {
  it('keeps a request that was issued and never answered, with its missing end intact', async () => {
    const { launch, ledger } = await grok();
    // Request 0 came back; request 1 was issued and the provider never answered
    // it. That second row is the whole reason this ledger is published.
    await write(requestsFile(ledger), requestRow() + requestRow({ request: 1, ended_at: undefined, output: 0, total: 5392 }));
    const published = await readSealedBrokerRequests(launch, once);
    expect(published?.outcome).toBe('read');
    if (published?.outcome !== 'read') throw new Error('unreachable');
    expect(published.read).toBe(2);
    expect(published.open).toBe(1);
    expect(published.truncated).toBe(false);
    const hung = published.rows[1]!;
    expect(hung.request).toBe(1);
    expect(hung.startedAt).toBe('2026-09-18T00:28:19.000Z');
    // Not filled, not normalised, not dropped: absent is what it observed.
    expect('endedAt' in hung).toBe(false);
    expect('durationMs' in hung).toBe(false);
    // A request the proxy never clocked at all publishes neither end, and a row
    // the broker wrote without a usage source publishes none.
    await write(requestsFile(ledger), requestRow({ started_at: undefined, ended_at: undefined, usage_source: undefined }));
    const unclocked = await readSealedBrokerRequests(launch, once);
    if (unclocked?.outcome !== 'read') throw new Error('unreachable');
    expect(unclocked.open).toBe(0);
    expect(unclocked.rows[0]).toEqual({ turn: 'a'.repeat(64), request: 0, requests: 1, model: 'grok-4.6', at: '2026-09-18T00:28:21.000Z',
      input: 5392, cachedInput: 256, freshInput: 5136, cacheWrite: 0, output: 158, total: 5550 });
    expect(published.rows[0]).toMatchObject({ request: 0, endedAt: '2026-09-18T00:28:21.000Z', durationMs: 2000, usageSource: 'stream',
      input: 5392, cachedInput: 256, freshInput: 5136, cacheWrite: 0, output: 158, total: 5550, model: 'grok-4.6' });
  });

  it('publishes nothing for a ledger that is absent or empty, and a classification for one it cannot read', async () => {
    const { launch, ledger, codex } = await grok();
    const file = requestsFile(ledger);
    // Absence must never arrive as an empty list: "no requests were made" is one
    // of the two answers this record exists to tell apart from "not observed".
    expect(await readSealedBrokerRequests(launch, once)).toBeUndefined();
    await write(file, '');
    expect(await readSealedBrokerRequests(launch, once)).toBeUndefined();
    await write(file, requestRow());
    expect(await readSealedBrokerRequests(codex, once)).toBeUndefined();
    expect(await readSealedBrokerRequests(launch, { attempts: 0 })).toBeUndefined();
    // Present but unreadable is a third thing, and says so without any rows.
    await write(file, '{ not json\n');
    expect(await readSealedBrokerRequests(launch, once)).toEqual({ schema: BROKER_REQUESTS_SCHEMA, outcome: 'unreadable', failure: 'malformed' });
    await write(file, requestRow({ total: 1 }));
    expect(await readSealedBrokerRequests(launch, once)).toEqual({ schema: BROKER_REQUESTS_SCHEMA, outcome: 'unreadable', failure: 'schema' });
    await write(file, requestRow() + requestRow({ output: 999 }));
    expect(await readSealedBrokerRequests(launch, once)).toEqual({ schema: BROKER_REQUESTS_SCHEMA, outcome: 'unreadable', failure: 'schema' });
    await write(file, requestRow().trimEnd());
    expect(await readSealedBrokerRequests(launch, once)).toEqual({ schema: BROKER_REQUESTS_SCHEMA, outcome: 'unreadable', failure: 'schema' });
    // A path the private-file guard refuses is an unreadable ledger, not a ledger that disagrees.
    await rm(file, { force: true });
    await mkdir(file, { recursive: true });
    expect(await readSealedBrokerRequests(launch, once)).toEqual({ schema: BROKER_REQUESTS_SCHEMA, outcome: 'unreadable', failure: 'unreadable' });
  });

  it('publishes timings and counts only, never a body or anything credential-shaped', async () => {
    const { launch, ledger } = await grok();
    // The broker's schema tolerates unknown members, so a row can carry more
    // than it is read for. None of it may reach an operator's event stream.
    await write(requestsFile(ledger), requestRow({
      prompt: 'the article assignment', messages: [{ role: 'user', content: 'secret wake text' }],
      response: 'the filed article', authorization: 'Bearer sk-live-4f2c9a', api_key: 'xai-abcdef012345',
    }));
    const published = JSON.stringify(await readSealedBrokerRequests(launch, once));
    for (const forbidden of ['prompt', 'messages', 'secret wake text', 'response', 'the filed article', 'authorization', 'Bearer', 'sk-live', 'api_key', 'xai-']) {
      expect(published).not.toContain(forbidden);
    }
    expect(published).toContain('"startedAt":"2026-09-18T00:28:19.000Z"');

    // A parse error quotes the line it choked on, so the failure note is a
    // classification rather than the message.
    await write(requestsFile(ledger), '{ "authorization": "Bearer sk-live-4f2c9a", broken\n');
    const failed = JSON.stringify(await readSealedBrokerRequests(launch, once));
    expect(failed).not.toContain('Bearer');
    expect(failed).not.toContain('sk-live');
    expect(failed).toContain('"failure":"malformed"');
  });

  it('bounds the published rows and keeps every unanswered one', async () => {
    const { launch, ledger } = await grok();
    const rows = Array.from({ length: 300 }, (_, index) =>
      requestRow({ request: index, ...(index === 3 ? { ended_at: undefined, output: 0, total: 5392 } : {}) })).join('');
    await write(requestsFile(ledger), rows);
    const published = await readSealedBrokerRequests(launch, once);
    if (published?.outcome !== 'read') throw new Error('unreachable');
    expect(published.read).toBe(300);
    expect(published.published).toBe(256);
    expect(published.truncated).toBe(true);
    // The oldest rows are dropped, the unanswered one never is, and file order survives.
    expect(published.rows[0]!.request).toBe(3);
    expect(published.rows.at(-1)!.request).toBe(299);
    expect(published.rows.filter(row => !('endedAt' in row))).toHaveLength(1);
  });

  it('waits the same bounded moment as the sealed usage read, then reports absence', async () => {
    const { launch, ledger } = await grok();
    // An unanswered request has no row until the broker seals the turn it
    // belongs to, so one immediate read would call it a request never issued.
    setTimeout(() => { void write(requestsFile(ledger), requestRow({ ended_at: undefined, output: 0, total: 5392 })); }, 30);
    const published = await readSealedBrokerRequests(launch, { attempts: 40, intervalMs: 10 });
    expect(published?.outcome === 'read' && published.open).toBe(1);
  });
});
