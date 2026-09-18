import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
});

it('reports absence rather than a zero when the broker sealed nothing', async () => {
  const f = await childFixture('die-mid-turn');
  roots.push(f.root);
  const launch = await grokLaunchFrom(f.launch, f.root);
  f.input.model = launch.agent.model;
  f.input.protectedPaths = [...grokProtectedPaths(f.root), f.launch.workspace.source, launch.projections[0]!.source];
  await writeGrokSlotReceipt(launch);
  await f.save();
  const session = await createDaimonNativeAdapter({ execution: { kind: 'child-process' }, sealedUsage: { attempts: 1, intervalMs: 0 } }).start(f.input);
  const result = await session.run({ id: 'wake-1', text: 'Carry out this delivery.' });
  expect(result.status).toBe('failed');
  // A row of zeroes here would be byte-identical to a measured zero.
  expect(result.usage).toBeNull();
  expect(result.coverage).toContainEqual({ channel: 'usage', completeness: 'absent', ordering: 'none' });
});
