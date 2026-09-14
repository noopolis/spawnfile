import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertFreshNativeEvidence, collectNativeEvidence, nativeUsageCoverage, readClosedTraces } from './evidence.js';
import type { NativeEvidence, NativeUsage } from './types.js';
import { executionId, traceFixture } from '../test-fixtures.js';

test('artifact reader retains real fields, never invents absent usage or tool calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-evidence-unit-'));
  try {
    await assertFreshNativeEvidence(root, join(root, 'usage.jsonl'), 'agent:writer', 'test-model-v1');
    await mkdir(join(root, 'telemetry'));
    await writeFile(join(root, 'telemetry/turns.ndjson'), `${JSON.stringify(traceFixture())}\n`);
    const evidence = await collectNativeEvidence(root, join(root, 'usage.jsonl'), 'agent:writer', executionId, 'test-model-v1');
    assert.deepEqual(evidence.traces, [traceFixture()]);
    assert.deepEqual(evidence.usage, []);
    assert.deepEqual(evidence.toolReceipts, []);
    await assert.rejects(assertFreshNativeEvidence(root, join(root, 'usage.jsonl'), 'agent:writer', 'test-model-v1'), /fresh execution/);
    await assert.rejects(collectNativeEvidence(root, join(root, 'usage.jsonl'), 'agent:writer', 'another-execution', 'test-model-v1'), /Foreign/);
    await writeFile(join(root, 'telemetry/turns.ndjson'), JSON.stringify(traceFixture()));
    await assert.rejects(readClosedTraces(root, 'agent:writer'), /torn/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('usage coverage requires one matching complete total and a completed trace', () => {
  const usage: NativeUsage = { v: 'noopolis.daimon.turn-usage.v1', agent: 'agent:writer', wake: executionId,
    engine: 'codex', input: 100, output: 10, cache_read: 20, total: 110, complete: true };
  const native: NativeEvidence = { usage: [usage], traces: [traceFixture()], toolReceipts: [], modelContexts: [] };
  assert.equal(nativeUsageCoverage(native, executionId), 'complete');
  assert.equal(nativeUsageCoverage(native), 'partial');
  assert.equal(nativeUsageCoverage({ ...native, usage: [] }, executionId), 'absent');
  assert.equal(nativeUsageCoverage({ ...native, usage: [usage, usage] }, executionId), 'partial');
  assert.equal(nativeUsageCoverage({ ...native, usage: [{ ...usage, complete: false }] }, executionId), 'partial');
  assert.equal(nativeUsageCoverage({ ...native, usage: [{ ...usage, wake: 'foreign' }] }, executionId), 'partial');
  assert.equal(nativeUsageCoverage({ ...native, traces: [] }, executionId), 'partial');
  assert.equal(nativeUsageCoverage({ ...native, traces: [traceFixture(), traceFixture()] }, executionId), 'partial');
  assert.equal(nativeUsageCoverage({ ...native, traces: [{ ...traceFixture(), turn_id: 'foreign' }] }, executionId), 'partial');
  assert.equal(nativeUsageCoverage({ ...native, traces: [{ ...traceFixture(), status: 'failed' }] }, executionId), 'partial');
});

test('usage evidence rejects duplicated totals, double-counted cache and inconsistent arithmetic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-usage-unit-'));
  try {
    const usage = { v: 'noopolis.daimon.turn-usage.v1', agent: 'agent:writer', wake: executionId, engine: 'codex',
      at: '2026-09-13T00:00:01.000Z', input: 100, output: 10, cache_read: 20, total: 110, complete: true };
    const read = () => collectNativeEvidence(root, join(root, 'usage.jsonl'), 'agent:writer', executionId, 'test-model-v1');
    await writeFile(join(root, 'usage.jsonl'), `${JSON.stringify(usage)}\n${JSON.stringify(usage)}\n`);
    await assert.rejects(read(), /Duplicate/);
    for (const invalid of [{ ...usage, total: 130 }, { ...usage, cache_read: 101 }]) {
      await writeFile(join(root, 'usage.jsonl'), `${JSON.stringify(invalid)}\n`);
      await assert.rejects(read(), /inconsistent/);
    }
    await writeFile(join(root, 'usage.jsonl'), `${JSON.stringify({ ...usage, complete: false })}\n`);
    assert.equal((await read()).usage[0]?.complete, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('artifact reader rejects usage and model identities from another execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-identity-unit-'));
  try {
    const usage = { v: 'noopolis.daimon.turn-usage.v1', agent: 'agent:writer', wake: executionId, engine: 'codex',
      at: '2026-09-13T00:00:01.000Z', input: 100, output: 10, cache_read: 20, total: 110, complete: true };
    await writeFile(join(root, 'usage.jsonl'), `${JSON.stringify(usage)}\n`);
    assert.equal((await collectNativeEvidence(root, join(root, 'usage.jsonl'), 'agent:writer', executionId, 'test-model-v1')).usage[0]?.input, 100);
    await assert.rejects(collectNativeEvidence(root, join(root, 'usage.jsonl'), 'agent:writer', 'foreign', 'test-model-v1'), /identity mismatch/);
    await mkdir(join(root, '.codex/sessions/2026/09/13'), { recursive: true });
    await writeFile(join(root, '.codex/sessions/2026/09/13/rollout-unit.jsonl'), `${JSON.stringify({ type: 'turn_context', payload: { model: 'different-model' } })}\n`);
    await assert.rejects(collectNativeEvidence(root, join(root, 'usage.jsonl'), 'agent:writer', executionId, 'test-model-v1'), /differs/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
