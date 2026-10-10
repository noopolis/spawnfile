import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Observation } from '../../contracts/execution.js';
import { aggregateUsage, createNativeObserver } from './observations.js';
import { BROKER_REQUESTS_SCHEMA, BROKER_SEAL_SCHEMA, type BrokerSealLedger, type BrokerSealRecord } from './sealed-usage.js';
import { launchFixture } from './test-fixtures.js';
import type { NativeUsage, TerminalEvidence } from './worker/index.js';

test('receipt observations preserve errors/results and deduplicate actual action identity', async () => {
  const fixture = await launchFixture();
  try {
    const home = join(fixture.input.runtimeHomePath, 'native/home');
    const directory = join(home, 'tool-state'); await mkdir(directory);
    const events: Observation[] = []; fixture.input.onObservation = event => { events.push(event); };
    const receipts = [
      { kind: 'mcp', server: 'newsroom', tool: 'file_article', is_error: false, result: { details: { accepted: true } } },
      { kind: 'mcp', server: 'newsroom', tool: 'file_article', is_error: true, error: 'Headline required' },
      { kind: 'moltnet', message_id: 'message-1' },
    ];
    for (const [index, row] of receipts.entries()) await writeFile(join(directory, `${String(index).repeat(64)}.json`), JSON.stringify({
      ...row, agent_id: 'agent:writer', engine: 'codex', delivery_id: `action-${index}`, at: new Date().toISOString() }));
    const observer = createNativeObserver(fixture.input, home, fixture.launch.agent.id);
    await observer.checkpoint('wake'); await observer.checkpoint('wake');
    assert.equal(events.length, 3);
    assert.equal(events[1]?.success, false);
    assert.equal(events[1]?.result, 'Headline required');
    assert.equal(events[2]?.tool, 'moltnet_send');
    assert.ok(events.every(event => event.args === undefined && event.type === 'tool.complete'));
    const usage = await observer.terminal('wake', { status: 'failed', completedAt: new Date().toISOString(), native: { usage: [] } } as unknown as TerminalEvidence);
    assert.equal(usage, null);
    assert.equal(events.at(-1)?.type, 'diagnostic');
    assert.throws(() => aggregateUsage([{ input: Number.MAX_SAFE_INTEGER, output: 0, cache_read: 0 },
      { input: 1, output: 0, cache_read: 0 }] as NativeUsage[]), /aggregate/);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('an unreadable broker request ledger publishes its classification as an operator diagnostic', async () => {
  const fixture = await launchFixture();
  try {
    const events: Observation[] = []; fixture.input.onObservation = event => { events.push(event); };
    const observer = createNativeObserver(fixture.input, fixture.input.runtimeHomePath, fixture.launch.agent.id, 'grok');
    // A ledger that was present and could not be read is neither "the request
    // hung" nor "no request was made", and it says so without any rows.
    await observer.brokerRequests('wake', { schema: BROKER_REQUESTS_SCHEMA, outcome: 'unreadable', failure: 'malformed' });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'diagnostic');
    assert.equal(events[0]?.text, 'Broker request ledger unreadable: malformed');
    assert.equal(JSON.stringify(events[0]).includes('"rows"'), false);
    // And a publish fault never fails a turn that has already failed.
    fixture.input.onObservation = () => { throw new Error('observation sink refused'); };
    await observer.brokerRequests('wake', { schema: BROKER_REQUESTS_SCHEMA, outcome: 'read', read: 1, published: 1, open: 1, truncated: false, rows: [] });
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

const seal = (overrides: Partial<BrokerSealRecord> = {}): BrokerSealRecord => ({
  turn: 'a'.repeat(64), wake: 'wake', at: '2026-09-18T00:28:21.000Z', model: 'grok-4.6',
  outcome: 'failed', requests: 10, limitReason: 'none', code: 'cancelled', ...overrides,
});

/**
 * The seal diagnostic's headline is the one sentence six live hangs could not
 * produce. Its three readings are different statements and must read as three.
 */
test('a broker turn seal names the tool call a hung turn was blocked on, and never invents one', async () => {
  const fixture = await launchFixture();
  try {
    const events: Observation[] = []; fixture.input.onObservation = event => { events.push(event); };
    const observer = createNativeObserver(fixture.input, fixture.input.runtimeHomePath, fixture.launch.agent.id, 'grok');
    const read = (rows: BrokerSealRecord[]): BrokerSealLedger => ({ schema: BROKER_SEAL_SCHEMA, outcome: 'read', read: rows.length,
      outstanding: rows.reduce((total, row) => total + (row.mcp?.outstanding.length ?? 0), 0),
      openTunnels: rows.reduce((total, row) => total + (row.mcp?.tunnels?.open.length ?? 0), 0), rows });

    await observer.brokerSeal('wake', read([seal({ mcp: { started: 1, answered: 0, undecoded: 0, outstanding: [{ name: 'use_tool', outstandingMs: 430112 }] } })]));
    assert.equal(events[0]?.type, 'diagnostic');
    assert.equal(events[0]?.text, 'Broker turn seal: failed/cancelled, blocked on use_tool@430112ms');

    // Observed and quiet.
    await observer.brokerSeal('wake', read([seal({ mcp: { started: 0, answered: 0, undecoded: 0, outstanding: [] } })]));
    assert.equal(events[1]?.text, 'Broker turn seal: failed/cancelled, no outstanding MCP call');

    // Never observed, which is not the same sentence.
    await observer.brokerSeal('wake', read([seal({ outcome: 'completed', code: undefined })]));
    assert.equal(events[2]?.text, 'Broker turn seal: completed, no MCP observation');

    await observer.brokerSeal('wake', { schema: BROKER_SEAL_SCHEMA, outcome: 'unreadable', failure: 'schema' });
    assert.equal(events[3]?.text, 'Broker turn seal unreadable: schema');

    await observer.brokerSeal('wake', read([]));
    assert.equal(events[4]?.text, 'Broker turn seal: unknown, no MCP observation');

    /*
     * The GET tunnel, named in the same sentence. A turn idle with its tunnel
     * still open reads differently from one that closed it, and a row that
     * never observed tunnels reports nothing rather than a zero nobody
     * measured.
     *
     * Mutation: drop the `get` clause and the first two go red; render it for
     * a row with no `tunnels` member and the third does.
     */
    const quiet = { started: 1, answered: 1, undecoded: 0, outstanding: [] };
    await observer.brokerSeal('wake', read([seal({ mcp: { ...quiet, tunnels: { opened: 1, closed: 0, delivered: 0, open: [{ openMs: 428004, delivered: false }] } } })]));
    assert.equal(events[5]?.text, 'Broker turn seal: failed/cancelled, no outstanding MCP call, GET tunnel open 428004ms/silent');

    await observer.brokerSeal('wake', read([seal({ mcp: { ...quiet, tunnels: { opened: 1, closed: 1, delivered: 1, open: [] } } })]));
    assert.equal(events[6]?.text, 'Broker turn seal: failed/cancelled, no outstanding MCP call, GET tunnels 1/1 closed');

    await observer.brokerSeal('wake', read([seal({ mcp: quiet })]));
    assert.equal(events[7]?.text, 'Broker turn seal: failed/cancelled, no outstanding MCP call');

    // It is a diagnostic throughout: never output, a captured call or a judge input.
    assert.ok(events.every(event => event.type === 'diagnostic'));
    // And a publish fault never fails a turn that has already failed.
    fixture.input.onObservation = () => { throw new Error('observation sink refused'); };
    await observer.brokerSeal('wake', read([seal()]));
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});


test('cumulative trial accounting rejects conflicting totals and retains legacy frame usage', async () => {
  const fixture = await launchFixture();
  try {
    const observer = createNativeObserver(fixture.input, fixture.input.runtimeHomePath, fixture.launch.agent.id);
    const row = { engine: 'codex', wake: 'execution', input: 10, output: 2, cache_read: 0 } as NativeUsage;
    const frame = { status: 'completed', completedAt: new Date().toISOString(),
      native: { usage: [row], accounting: { usage: [row], coverage: 'complete' } } } as TerminalEvidence;
    assert.equal((await observer.terminal('task', frame))?.inputTokens, 10);
    assert.equal(await observer.terminal('task', frame), null);
    await assert.rejects(observer.terminal('continuation', { ...frame,
      native: { ...frame.native, accounting: { usage: [{ ...row, input: 20 }], coverage: 'complete' } } }), /Conflicting native trial usage/);
    const legacy = { ...frame, native: { ...frame.native, accounting: undefined } };
    assert.equal((await observer.terminal('legacy', legacy))?.inputTokens, 10);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
