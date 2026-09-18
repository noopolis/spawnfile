import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { Observation } from '../../contracts/execution.js';
import { childFixture } from './child/fixture.js';
import { grokLaunchFrom, grokProtectedPaths, writeGrokSlotReceipt } from './grok-fixtures.js';
import { createDaimonNativeAdapter } from './index.js';

vi.mock('./child/sandbox.js', () => ({ verifyChildSandbox: vi.fn(async () => undefined) }));
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/**
 * A brokered Grok worker that did its work and then lost its transport.
 *
 * The live failure this covers reported three successful tool calls, then
 * `Native worker transport failed`, `usage: absent` and `$0` — for a turn that
 * really spent money. The worker's HTTP reply is the only route usage normally
 * takes to the adapter, so losing it lost the spend as well as the result. The
 * broker is a separate process and had already sealed what its proxy metered,
 * which is what the ledger below stands for.
 */
const sealedRow = (agent: string): string => JSON.stringify({
  v: 'noopolis.daimon.turn-usage.v1', agent, wake: 'wake-1', engine: 'grok', at: '2026-09-18T00:28:21.000Z',
  input: 5136, output: 158, cache_read: 256, cache_write: 0, total: 5550, calls: 2, notional_usd: 0.02,
  complete: false, outcome: 'failed', reason: 'unknown', turn: 'a'.repeat(64), limit_reason: 'none', model: 'grok-4.6',
}) + '\n';

/**
 * The broker's second stream: one row per provider request, with the proxy's own
 * clocks. A turn killed by its deadline is otherwise unreadable — a request
 * issued and never answered looks exactly like a request never issued — and the
 * file dies with the slot's tmpfs unless the failure path publishes it.
 */
const requestRows = (agent: string): string => [
  { request: 0, output: 158, total: 5550, ended_at: '2026-09-18T00:28:21.000Z' },
  { request: 1, output: 0, total: 5392 },
].map(row => JSON.stringify({
  v: 'noopolis.daimon.turn-requests.v1', agent, wake: 'wake-1', engine: 'grok', at: '2026-09-18T00:28:21.000Z',
  turn: 'a'.repeat(64), model: 'grok-4.6', requests: 2, input: 5392, cached_input: 256, fresh_input: 5136,
  cache_write: 0, usage_source: 'stream', started_at: '2026-09-18T00:28:19.000Z', ...row,
}) + '\n').join('');

/**
 * The broker's third stream: one row per *sealed terminal turn*.
 *
 * The sealed response carries the failure code, the worker's redacted last
 * words and the MCP tool call the worker was still blocked on — and it travels
 * only in a reply a hung turn never sends. This row is that same seal on a file
 * in the slot ledger directory, which outlives the container's tmpfs.
 */
const sealRow = (agent: string): string => JSON.stringify({
  v: 'noopolis.daimon.turn-seal.v1', agent, wake: 'wake-1', engine: 'grok', at: '2026-09-18T00:28:21.000Z',
  turn: 'a'.repeat(64), outcome: 'failed', requests: 10, model: 'grok-4.6', limit_reason: 'none', code: 'cancelled',
  diagnostic: { status: 'cancelled', stage: 'wait', failure_class: 'cancelled', exit_code: 0, term_signal: 9 },
  mcp: { started: 1, answered: 0, undecoded: 0, outstanding: [{ name: 'use_tool', outstanding_ms: 430112 }] },
}) + '\n';

const brokerRequests = (rows: readonly Observation[]): Observation | undefined => rows.find(row => row.type === 'diagnostic' &&
  (row as { native?: { schema?: string } }).native?.schema === 'paideia.daimon-native.broker-requests.v1');
const brokerSeal = (rows: readonly Observation[]): Observation | undefined => rows.find(row => row.type === 'diagnostic' &&
  (row as { native?: { schema?: string } }).native?.schema === 'paideia.daimon-native.broker-seal.v1');

it('records the spend the broker sealed when a brokered worker dies with its terminal frame unsent', async () => {
  const f = await childFixture('die-mid-turn');
  roots.push(f.root);
  const launch = await grokLaunchFrom(f.launch, f.root);
  f.input.model = launch.agent.model;
  f.input.protectedPaths = [...grokProtectedPaths(f.root), f.launch.workspace.source, launch.projections[0]!.source];
  await writeGrokSlotReceipt(launch);
  await f.save();
  const ledger = launch.broker.usageLedgerPath;
  await mkdir(dirname(ledger), { recursive: true, mode: 0o700 });
  await writeFile(ledger, sealedRow(launch.agent.id), { mode: 0o600 });
  await writeFile(join(dirname(ledger), 'requests.jsonl'), requestRows(launch.agent.id), { mode: 0o600 });
  await writeFile(join(dirname(ledger), 'turns.jsonl'), sealRow(launch.agent.id), { mode: 0o600 });

  const observations: Observation[] = [];
  const input = { ...f.input, onObservation: (value: Observation) => { observations.push(value); } };
  const session = await createDaimonNativeAdapter({ execution: { kind: 'child-process' }, sealedUsage: { attempts: 2, intervalMs: 5 } }).start(input);
  const result = await session.run({ id: 'wake-1', text: 'Carry out this delivery.' });

  // The turn still fails and its closure is still unconfirmed: nothing here
  // launders a lost result into a success.
  expect(result.status).toBe('failed');
  expect(result.error).toContain('Native worker transport failed');
  expect(result.stop).toMatchObject({ state: 'unknown', quiescence: 'unknown' });

  // What changed: the spend is reported, from the broker's own measurement.
  expect(result.usage).toMatchObject({ inputTokens: 5392, cachedInputTokens: 256, outputTokens: 158, notionalUsd: 0.02 });
  // Measured but never complete — the execution it belongs to never closed.
  expect(result.coverage).toContainEqual({ channel: 'usage', completeness: 'partial', ordering: 'source' });

  // And it reaches the durable event stream, where a completed trial's usage goes.
  const usage = observations.filter(row => row.type === 'usage');
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({ wakeId: 'wake-1', usage: { outputTokens: 158 } });

  // The worker's own last words survive the container, redacted, as the only
  // account of why it stopped answering.
  const diagnostic = observations.find(row => row.type === 'diagnostic' &&
    (row as { native?: { schema?: string } }).native?.schema === 'paideia.daimon-native.startup-diagnostic.v1');
  expect(diagnostic).toBeDefined();
  expect(JSON.stringify(diagnostic)).toContain('stream bound crossed');

  // And the per-request timings, which are the only evidence that separates a
  // request issued and never answered from one the worker never issued.
  const requests = brokerRequests(observations);
  expect(requests).toMatchObject({ wakeId: 'wake-1', text: 'Broker request ledger: 2 requests, 1 unanswered' });
  const ledgerRecord = (requests as { native: { rows: Record<string, unknown>[]; open: number } }).native;
  expect(ledgerRecord.open).toBe(1);
  expect(ledgerRecord.rows[1]).toMatchObject({ request: 1, startedAt: '2026-09-18T00:28:19.000Z' });
  expect('endedAt' in ledgerRecord.rows[1]!).toBe(false);

  // And the sealed terminal record itself — the outstanding tool call that only
  // ever existed inside a response this turn never got to send.
  const seal = brokerSeal(observations);
  expect(seal).toMatchObject({ wakeId: 'wake-1', text: 'Broker turn seal: failed/cancelled, blocked on use_tool@430112ms' });
  expect((seal as { native: { rows: Record<string, unknown>[] } }).native.rows[0])
    .toMatchObject({ code: 'cancelled', limitReason: 'none', failureClass: 'cancelled',
      mcp: { started: 1, answered: 0, outstanding: [{ name: 'use_tool', outstandingMs: 430112 }] } });
});

it('reports absence rather than a zero when the broker sealed nothing', async () => {
  const f = await childFixture('die-mid-turn');
  roots.push(f.root);
  const launch = await grokLaunchFrom(f.launch, f.root);
  f.input.model = launch.agent.model;
  f.input.protectedPaths = [...grokProtectedPaths(f.root), f.launch.workspace.source, launch.projections[0]!.source];
  await writeGrokSlotReceipt(launch);
  await f.save();
  const observations: Observation[] = [];
  const session = await createDaimonNativeAdapter({ execution: { kind: 'child-process' }, sealedUsage: { attempts: 1, intervalMs: 0 } })
    .start({ ...f.input, onObservation: (value: Observation) => { observations.push(value); } });
  const result = await session.run({ id: 'wake-1', text: 'Carry out this delivery.' });
  expect(result.status).toBe('failed');
  // A row of zeroes here would be byte-identical to a measured zero.
  expect(result.usage).toBeNull();
  expect(result.coverage).toContainEqual({ channel: 'usage', completeness: 'absent', ordering: 'none' });
  // No request ledger either: an empty one would read as "no requests were made".
  expect(brokerRequests(observations)).toBeUndefined();
  // And no seal: an empty record would read as "the turn sealed nothing", which
  // is exactly the reading this stream exists to make impossible.
  expect(brokerSeal(observations)).toBeUndefined();
});
