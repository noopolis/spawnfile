import { expect, test } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertFreshNativeEvidence, collectNativeEvidence, GROK_TURN_NOTIONAL_USD_MAX, nativeUsageCoverage, readToolReceipts } from './evidence.js';
import { aggregateUsage } from '../observations.js';
import { executionId, traceFixture } from '../test-fixtures.js';
import type { NativeGrokUsage } from './types.js';

const turn = 'c'.repeat(64);
/** Shape of Daimon's `renderTurnUsageLine` for a sealed broker turn. */
const row = { v: 'noopolis.daimon.turn-usage.v1', agent: 'agent:writer', wake: executionId, engine: 'grok', at: '2026-09-17T00:00:02.000Z',
  input: 2677, output: 92, cache_read: 2816, cache_write: 10, total: 5595, calls: 2, notional_usd: 0.00248676, complete: true,
  outcome: 'completed', turn, limit_reason: 'none', model: 'grok-4.6' };
/** Shape of Daimon's `renderGrokTurnRequestLines`. */
const request = { v: 'noopolis.daimon.turn-requests.v1', agent: 'agent:writer', wake: executionId, engine: 'grok', at: '2026-09-17T00:00:02.000Z',
  turn, model: 'grok-4.6', request: 0, requests: 1, input: 5493, cached_input: 2816, fresh_input: 2677, cache_write: 10, output: 92, total: 5595,
  usage_source: 'stream', started_at: '2026-09-17T00:00:00.500Z', ended_at: '2026-09-17T00:00:01.900Z' };
const lines = (...values: unknown[]) => values.map(value => `${JSON.stringify(value)}\n`).join('');

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'native-grok-evidence-'));
  const usage = join(root, 'slot/usage.jsonl'), requests = join(root, 'slot/requests.jsonl');
  await mkdir(join(root, 'slot')); await mkdir(join(root, 'telemetry'));
  await writeFile(join(root, 'telemetry/turns.ndjson'), lines(traceFixture()));
  const read = (execution: string | undefined = executionId, model = 'grok-4.6') =>
    collectNativeEvidence(root, usage, 'agent:writer', execution, model, [], { engine: 'grok', requestsFile: requests });
  return { root, usage, requests, read };
}

test('Grok usage keeps disjoint buckets, per-request clocks and normalizes cache reads and writes as input subsets', async () => {
  const f = await workspace();
  try {
    await writeFile(f.usage, lines(row)); await writeFile(f.requests, lines(request));
    const evidence = await f.read();
    expect(evidence.usage).toEqual([row]);
    expect(evidence.requests).toEqual([request]);
    expect(evidence.modelContexts).toEqual([{ model: 'grok-4.6', approvalPolicy: null, sandboxPolicy: null }]);
    expect(nativeUsageCoverage(evidence, executionId)).toBe('complete');
    expect(aggregateUsage(evidence.usage)).toEqual({ inputTokens: 5503, cachedInputTokens: 2816, cacheWriteInputTokens: 10, outputTokens: 92,
      reasoningTokens: null, notionalUsd: 0.00248676, source: 'noopolis.daimon.turn-usage.v1' });
    expect(() => aggregateUsage([row as NativeGrokUsage, { ...row, engine: 'codex' } as never])).toThrow('mixes engines');
    for (const notional_usd of [Number.NaN, -1, 1e15, Number.MAX_VALUE, GROK_TURN_NOTIONAL_USD_MAX + 0.01]) {
      expect(() => aggregateUsage([{ ...row, notional_usd } as NativeGrokUsage])).toThrow('plausibility');
    }
    expect(aggregateUsage([{ ...row, notional_usd: GROK_TURN_NOTIONAL_USD_MAX } as NativeGrokUsage])?.notionalUsd).toBe(GROK_TURN_NOTIONAL_USD_MAX);
    const estimated = { ...row, estimated_requests: 1 };
    await writeFile(f.usage, lines(estimated));
    expect(nativeUsageCoverage(await f.read(), executionId)).toBe('partial');
    expect((await f.read()).usage[0]?.estimated_requests).toBe(1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('Grok usage never passes the Codex total rule and replays are counted once', async () => {
  const f = await workspace();
  try {
    await writeFile(f.usage, lines({ ...row, total: row.input + row.output }));
    await expect(f.read()).rejects.toThrow('Grok token totals are inconsistent');
    await writeFile(f.usage, lines(row, row));
    const replayed = await f.read();
    expect(replayed.usage).toHaveLength(1);
    expect(aggregateUsage(replayed.usage)?.inputTokens).toBe(5503);
    await writeFile(f.usage, lines(row, { ...row, output: 93, total: 5596 }));
    await expect(f.read()).rejects.toThrow('Conflicting');
    await writeFile(f.usage, lines(row, { ...row, turn: 'd'.repeat(64) }));
    await expect(f.read()).rejects.toThrow('Duplicate native usage execution');
    await writeFile(f.requests, lines(request, request));
    await writeFile(f.usage, lines(row));
    expect((await f.read()).requests).toHaveLength(1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('Grok rows accept only the declared model or its build alias and reject malformed identity', async () => {
  const f = await workspace();
  try {
    await writeFile(f.usage, lines({ ...row, model: 'grok-4.6-build' }));
    expect((await f.read()).modelContexts[0]?.model).toBe('grok-4.6');
    for (const model of ['grok-4.5', undefined]) {
      await writeFile(f.usage, lines({ ...row, model }));
      await expect(f.read()).rejects.toThrow('model differs');
    }
    for (const invalid of [{ engine: 'codex' }, { turn: 'short' }, { notional_usd: -1 }, { notional_usd: 'free' }, { notional_usd: 1e15 }, { notional_usd: Number.MAX_VALUE }, { cache_write: undefined },
      { limit_reason: 'budget' }, { estimated_requests: 0 }, { wake: undefined }, { agent: 'another-agent' }, { at: 'never' }]) {
      await writeFile(f.usage, lines({ ...row, ...invalid }));
      await expect(f.read()).rejects.toThrow('Grok usage schema');
    }
    await writeFile(f.usage, lines(row));
    // A sealed row of this trial's that another of its wakes spent is that wake's
    // account, not this one's: dropped from this wake's evidence rather than
    // refused, so a continuation never fails over its own trial's earlier spend.
    await writeFile(f.usage, lines({ ...row, wake: 'another-execution', turn: 'e'.repeat(64) }));
    expect((await f.read()).usage).toEqual([]);
    await writeFile(f.usage, lines(row));
    for (const invalid of [{ usage_source: 'guess' }, { started_at: 'x' }, { ended_at: '2026-09-17T00:00:00.000Z' }, { turn: undefined }, { wake: undefined }, { agent: 'another-agent' }]) {
      await writeFile(f.requests, lines({ ...request, ...invalid }));
      await expect(f.read()).rejects.toThrow('Grok request schema');
    }
    for (const invalid of [{ fresh_input: 1 }, { total: 1 }]) {
      await writeFile(f.requests, lines({ ...request, ...invalid }));
      await expect(f.read()).rejects.toThrow('Grok request totals');
    }
    await writeFile(f.requests, lines({ ...request, model: 'grok-build' }));
    await expect(f.read()).rejects.toThrow('model differs');
    await writeFile(f.requests, lines(request, { ...request, output: 1, total: 5504 }));
    await expect(f.read()).rejects.toThrow('Conflicting');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('fresh Grok slots and tool receipts are engine-bound', async () => {
  const f = await workspace();
  try {
    await rm(join(f.root, 'telemetry/turns.ndjson'));
    const source = { engine: 'grok', requestsFile: f.requests } as const;
    await assertFreshNativeEvidence(f.root, f.usage, 'agent:writer', 'grok-4.6', source);
    await writeFile(f.requests, lines(request));
    await expect(assertFreshNativeEvidence(f.root, f.usage, 'agent:writer', 'grok-4.6', source)).rejects.toThrow('fresh');
    await mkdir(join(f.root, 'tool-state'));
    await writeFile(join(f.root, 'tool-state', `${'a'.repeat(64)}.json`), JSON.stringify({ kind: 'moltnet', agent_id: 'agent:writer', engine: 'grok',
      delivery_id: 'action', at: '2026-09-17T00:00:01.000Z' }));
    expect(await readToolReceipts(f.root, 'agent:writer', 'grok')).toHaveLength(1);
    await expect(readToolReceipts(f.root, 'agent:writer')).rejects.toThrow('identity');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('estimated request rows make coverage partial and must agree with the usage row', async () => {
  const f = await workspace();
  try {
    await writeFile(f.usage, lines(row));
    await writeFile(f.requests, lines({ ...request, usage_source: 'estimated' }));
    await expect(f.read()).rejects.toThrow('disagree');
    await writeFile(f.usage, lines({ ...row, estimated_requests: 1 }));
    const agreed = await f.read();
    expect(nativeUsageCoverage(agreed, executionId)).toBe('partial');
    expect(nativeUsageCoverage({ ...agreed, usage: [row as NativeGrokUsage] }, executionId)).toBe('partial');
    await writeFile(f.requests, lines({ ...request, turn: 'd'.repeat(64), usage_source: 'estimated' }));
    await writeFile(f.usage, lines(row));
    expect(nativeUsageCoverage(await f.read(), executionId)).toBe('partial');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
