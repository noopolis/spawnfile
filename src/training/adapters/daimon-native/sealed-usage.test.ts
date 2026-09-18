import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { grokLaunchFrom } from './grok-fixtures.js';
import { BROKER_REQUESTS_SCHEMA, BROKER_SEAL_SCHEMA, readSealedBrokerRequests, readSealedBrokerSeal, readSealedBrokerUsage } from './sealed-usage.js';
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

/**
 * One `noopolis.daimon.turn-seal.v1` row, byte-identical to what Daimon's
 * `renderBrokerTurnSealLine` emits for the live hang: ten provider requests,
 * all closed, then 430 s blocked on one `use_tool` call and an abort. Member
 * order and spelling are the renderer's, not this test's.
 */
const sealRow = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  v: 'noopolis.daimon.turn-seal.v1', agent: 'agent:writer', wake: 'wake-1', engine: 'grok', at: '2026-09-18T00:28:21.000Z',
  turn: 'a'.repeat(64), outcome: 'failed', requests: 10, model: 'grok-4.6', limit_reason: 'none', code: 'cancelled',
  diagnostic: { status: 'cancelled', stage: 'wait', failure_class: 'cancelled', exit_code: 0, term_signal: 9, reason: 'worker cancelled mid-turn' },
  mcp: { started: 1, answered: 0, undecoded: 0, outstanding: [{ name: 'use_tool', outstanding_ms: 430112 }] }, ...overrides,
}) + '\n';
const sealFile = (ledger: string): string => join(dirname(ledger), 'turns.jsonl');

describe('readSealedBrokerSeal', () => {
  /**
   * The finding six live runs could not deliver. The turn was cancelled, so its
   * sealed terminal response was answered to a client that had already gone;
   * this row is the same seal on a file that outlives the slot.
   *
   * Mutation: drop the `mcp` branch from `sealRecord`, or the `mcp` member from
   * Daimon's renderer, and the outstanding call disappears here.
   */
  it('publishes the tool call a cancelled turn was still blocked on, and the worker\'s redacted last words', async () => {
    const { launch, ledger } = await grok();
    await write(sealFile(ledger), sealRow());
    const published = await readSealedBrokerSeal(launch, once);
    expect(published?.outcome).toBe('read');
    if (published?.outcome !== 'read') throw new Error('unreachable');
    expect(published.read).toBe(1);
    expect(published.outstanding).toBe(1);
    expect(published.rows[0]).toEqual({
      turn: 'a'.repeat(64), wake: 'wake-1', at: '2026-09-18T00:28:21.000Z', model: 'grok-4.6',
      outcome: 'failed', requests: 10, limitReason: 'none', code: 'cancelled',
      status: 'cancelled', stage: 'wait', failureClass: 'cancelled', exitCode: 0, termSignal: 9,
      reason: 'worker cancelled mid-turn',
      mcp: { started: 1, answered: 0, undecoded: 0, outstanding: [{ name: 'use_tool', outstandingMs: 430112 }] },
    });
  });

  /**
   * Three states that have been read as one another all session: observed and
   * quiet, never observed, and never sealed.
   *
   * Mutation: emit `mcp` unconditionally in `sealRecord` (zeros for an absent
   * observation) and the second expectation goes red; publish an empty ledger
   * as `read` with no rows and the third does.
   */
  it('tells "called nothing" from "never observed" from "no seal at all"', async () => {
    const { launch, ledger } = await grok();
    await write(sealFile(ledger), sealRow({ mcp: { started: 0, answered: 0, undecoded: 0, outstanding: [] } }));
    const quiet = await readSealedBrokerSeal(launch, once);
    if (quiet?.outcome !== 'read') throw new Error('unreachable');
    expect(quiet.rows[0]!.mcp).toEqual({ started: 0, answered: 0, undecoded: 0, outstanding: [] });
    expect(quiet.outstanding).toBe(0);

    const { mcp: _dropped, ...withoutMcp } = JSON.parse(sealRow()) as Record<string, unknown>;
    await write(sealFile(ledger), JSON.stringify(withoutMcp) + '\n');
    const unobserved = await readSealedBrokerSeal(launch, once);
    if (unobserved?.outcome !== 'read') throw new Error('unreachable');
    expect('mcp' in unobserved.rows[0]!).toBe(false);

    // A completed turn seals too, and carries no failure code, no diagnostic
    // and no observation — only what was measured.
    await write(sealFile(ledger), JSON.stringify({ ...JSON.parse(sealRow()) as Record<string, unknown>, outcome: 'completed', code: undefined, diagnostic: undefined, mcp: undefined }) + '\n');
    const completed = await readSealedBrokerSeal(launch, once);
    if (completed?.outcome !== 'read') throw new Error('unreachable');
    expect(completed.rows[0]).toEqual({ turn: 'a'.repeat(64), wake: 'wake-1', at: '2026-09-18T00:28:21.000Z',
      model: 'grok-4.6', outcome: 'completed', requests: 10, limitReason: 'none' });

    await rm(sealFile(ledger), { force: true });
    expect(await readSealedBrokerSeal(launch, once)).toBeUndefined();
  });

  /**
   * The other channel a worker can be idle on.
   *
   * A brokered turn closed every provider request, answered every tool call,
   * and still sat until its deadline. The session's standalone GET SSE tunnel
   * is the one thing the facade relays for the whole session, so a turn sealed
   * with one still open — and how long it had been open, and whether the mount
   * had ever pushed a byte through it — is what separates a worker parked on
   * that stream from a worker doing nothing.
   *
   * Mutation: drop the `tunnels` branch from `sealRecord` and the first
   * expectation goes red; emit it unconditionally (zeros for a row that never
   * carried one) and the third does.
   */
  it('publishes a GET tunnel left open with its age, a closed one, and never invents either', async () => {
    const { launch, ledger } = await grok();
    const mcp = (tunnels: unknown): Record<string, unknown> => ({ mcp: { started: 1, answered: 1, undecoded: 0, outstanding: [], tunnels } });

    await write(sealFile(ledger), sealRow(mcp({ opened: 1, closed: 0, delivered: 0, open: [{ open_ms: 428004, delivered: false }] })));
    const parked = await readSealedBrokerSeal(launch, once);
    if (parked?.outcome !== 'read') throw new Error('unreachable');
    expect(parked.rows[0]!.mcp?.tunnels).toEqual({ opened: 1, closed: 0, delivered: 0, open: [{ openMs: 428004, delivered: false }] });
    expect(parked.openTunnels).toBe(1);

    // Closed before the seal, having carried frames: measured, and not open.
    await write(sealFile(ledger), sealRow(mcp({ opened: 1, closed: 1, delivered: 1, open: [] })));
    const ended = await readSealedBrokerSeal(launch, once);
    if (ended?.outcome !== 'read') throw new Error('unreachable');
    expect(ended.rows[0]!.mcp?.tunnels).toEqual({ opened: 1, closed: 1, delivered: 1, open: [] });
    expect(ended.openTunnels).toBe(0);

    // And the absence: a row sealed before the broker observed that channel.
    await write(sealFile(ledger), sealRow());
    const unobserved = await readSealedBrokerSeal(launch, once);
    if (unobserved?.outcome !== 'read') throw new Error('unreachable');
    expect('tunnels' in unobserved.rows[0]!.mcp!).toBe(false);
    expect(unobserved.openTunnels).toBe(0);
  });

  it('publishes nothing for an absent or empty stream, a classification for one it cannot read, and nothing for a launch with no broker', async () => {
    const { launch, ledger, codex } = await grok();
    const file = sealFile(ledger);
    expect(await readSealedBrokerSeal(launch, once)).toBeUndefined();
    await write(file, '');
    expect(await readSealedBrokerSeal(launch, once)).toBeUndefined();
    await write(file, sealRow());
    expect(await readSealedBrokerSeal(codex, once)).toBeUndefined();
    expect(await readSealedBrokerSeal(launch, { attempts: 0 })).toBeUndefined();
    await write(file, '{ not json\n');
    expect(await readSealedBrokerSeal(launch, once)).toEqual({ schema: BROKER_SEAL_SCHEMA, outcome: 'unreadable', failure: 'malformed' });
    // Each refusal of the strict reader, one per member it types.
    for (const bad of [{ v: 'noopolis.daimon.turn-seal.v2' }, { agent: 'agent:other' }, { engine: 'codex' }, { at: 'never' },
      { turn: 'short' }, { requests: -1 }, { outcome: 'cancelled' }, { limit_reason: 'deadline' }, { code: undefined },
      { outcome: 'completed' }, { code: 'invented' }, { model: 'grok-9' },
      { diagnostic: { status: 'cancelled', stage: 'wait', failure_class: 'cancelled', exit_code: 0 } },
      { diagnostic: { status: 'cancelled', stage: 'wait', failure_class: 'cancelled', exit_code: 0, term_signal: 9, reason: 'a\u0000b' } },
      { mcp: { started: 0, answered: 1, undecoded: 0, outstanding: [] } },
      { mcp: { started: 1, answered: 0, undecoded: 0, outstanding: [{ name: 'use tool', outstanding_ms: 1 }] } },
      { mcp: { started: 1, answered: 1, undecoded: 0, outstanding: [{ name: 'use_tool', outstanding_ms: 1 }] } },
      { mcp: { started: 1, answered: 0, undecoded: 0, outstanding: [{ name: 'use_tool' }] } },
      // The tunnel member, at the same strictness: nothing closes before it
      // opens, nothing delivers without opening, no more is open than
      // `opened - closed`, and `delivered` is a boolean, not a count.
      { mcp: { started: 0, answered: 0, undecoded: 0, outstanding: [], tunnels: { opened: 1, closed: 2, delivered: 0, open: [] } } },
      { mcp: { started: 0, answered: 0, undecoded: 0, outstanding: [], tunnels: { opened: 1, closed: 0, delivered: 2, open: [] } } },
      { mcp: { started: 0, answered: 0, undecoded: 0, outstanding: [], tunnels: { opened: 1, closed: 1, delivered: 0, open: [{ open_ms: 1, delivered: false }] } } },
      { mcp: { started: 0, answered: 0, undecoded: 0, outstanding: [], tunnels: { opened: 1, closed: 0, delivered: 0, open: [{ open_ms: -1, delivered: false }] } } },
      { mcp: { started: 0, answered: 0, undecoded: 0, outstanding: [], tunnels: { opened: 1, closed: 0, delivered: 0, open: [{ open_ms: 1, delivered: 1 }] } } },
      { mcp: { started: 0, answered: 0, undecoded: 0, outstanding: [], tunnels: { opened: 1, closed: 0, delivered: 0, open: [{ open_ms: 1, delivered: false, session_id: 'mcp-0' }] } } },
      { mcp: { started: 0, answered: 0, undecoded: 0, outstanding: [], tunnels: { opened: 9, closed: 0, delivered: 0, open: Array.from({ length: 9 }, () => ({ open_ms: 1, delivered: false })) } } },
      { mcp: { started: 0, answered: 0, undecoded: 0, outstanding: [], tunnels: { opened: 1, closed: 0, open: [] } } }]) {
      await write(file, sealRow(bad));
      expect(await readSealedBrokerSeal(launch, once), JSON.stringify(bad)).toEqual({ schema: BROKER_SEAL_SCHEMA, outcome: 'unreadable', failure: 'schema' });
    }
    await rm(file, { force: true });
    await mkdir(file, { recursive: true });
    expect(await readSealedBrokerSeal(launch, once)).toEqual({ schema: BROKER_SEAL_SCHEMA, outcome: 'unreadable', failure: 'unreadable' });
  });

  it('publishes names, timings and closed vocabularies only, collapses a replayed seal, and waits the same bounded moment', async () => {
    const { launch, ledger } = await grok();
    const file = sealFile(ledger);
    // The broker's row tolerates unknown members; none of them may reach an operator.
    await write(file, sealRow({ prompt: 'the article assignment', authorization: 'Bearer sk-live-4f2c9a', text: 'the filed article' }));
    const published = JSON.stringify(await readSealedBrokerSeal(launch, once));
    for (const forbidden of ['prompt', 'the article assignment', 'authorization', 'Bearer', 'sk-live', 'the filed article']) expect(published).not.toContain(forbidden);
    expect(published).toContain('"outstandingMs":430112');

    // A replay appends the same bytes twice; a reader counts that turn once.
    await write(file, sealRow() + sealRow() + sealRow({ turn: 'b'.repeat(64) }));
    const deduped = await readSealedBrokerSeal(launch, once);
    if (deduped?.outcome !== 'read') throw new Error('unreachable');
    expect(deduped.read).toBe(2);

    await rm(file, { force: true });
    setTimeout(() => { void write(file, sealRow()); }, 30);
    const waited = await readSealedBrokerSeal(launch, { attempts: 40, intervalMs: 10 });
    expect(waited?.outcome === 'read' && waited.outstanding).toBe(1);
  });

  it('bounds the published seals to the most recent turns', async () => {
    const { launch, ledger } = await grok();
    const many = Array.from({ length: 80 }, (_, index) => sealRow({ turn: index.toString(16).padStart(64, '0') })).join('');
    await write(sealFile(ledger), many);
    const published = await readSealedBrokerSeal(launch, once);
    if (published?.outcome !== 'read') throw new Error('unreachable');
    expect(published.read).toBe(80);
    expect(published.rows).toHaveLength(64);
    expect(published.rows.at(-1)!.turn).toBe((79).toString(16).padStart(64, '0'));
  });
});
