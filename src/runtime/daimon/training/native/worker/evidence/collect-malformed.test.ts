import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectNativeEvidence, readClosedTraces, readToolReceipts } from './index.js';
import { traceFixture } from '../../test-fixtures.js';

test('native evidence rejects malformed, foreign, unsafe and contradictory records', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-malformed-unit-')));
  try {
    const trace = join(root, 'telemetry/turns.ndjson'); await mkdir(join(root, 'telemetry'));
    const variants = [null, [], { ...traceFixture(), schema: 'foreign' }, { ...traceFixture(), agent_id: 'other' },
      { ...traceFixture(), turn_id: null }, { ...traceFixture(), started_at: 'invalid' }, { ...traceFixture(), completed_at: 'invalid' },
      { ...traceFixture(), started_at: '2030-01-01' }, { ...traceFixture(), status: 'running' }, { ...traceFixture(), tools: null }];
    for (const value of variants) { await writeFile(trace, `${JSON.stringify(value)}\n`); await assert.rejects(readClosedTraces(root, 'agent:writer')); }
    await writeFile(trace, '');
    const receipts = join(root, 'tool-state'); await mkdir(receipts);
    const file = join(receipts, `${'a'.repeat(64)}.json`);
    for (const value of [{ agent_id: 'foreign' }, { kind: 'mcp', agent_id: 'agent:writer', engine: 'codex', delivery_id: 'action', at: new Date().toISOString() }]) {
      await writeFile(file, JSON.stringify(value)); await assert.rejects(readToolReceipts(root, 'agent:writer'));
    }
    await rm(file);
    const sessions = join(root, '.codex/sessions'); await mkdir(sessions, { recursive: true });
    const rollout = join(sessions, 'unit.jsonl');
    await writeFile(rollout, `${JSON.stringify({ type: 'response_item', payload: { private: 'never exported' } })}\n${JSON.stringify({ type: 'turn_context', payload: {} })}\n`);
    await assert.rejects(collectNativeEvidence(root, join(root, 'usage'), 'agent:writer', undefined, 'test-model-v1'), /omitted its model/);
    await rm(rollout); await symlink(trace, rollout);
    await assert.rejects(collectNativeEvidence(root, join(root, 'usage'), 'agent:writer', undefined, 'test-model-v1'), /symlinks/);
    await rm(rollout); await mkdir(join(sessions, '1/2/3/4/5'), { recursive: true });
    await assert.rejects(collectNativeEvidence(root, join(root, 'usage'), 'agent:writer', undefined, 'test-model-v1'), /depth/);
    await rm(join(sessions, '1'), { recursive: true });
    for (let index = 0; index < 9; index++) await writeFile(join(sessions, `${index}.jsonl`), '');
    await assert.rejects(collectNativeEvidence(root, join(root, 'usage'), 'agent:writer', undefined, 'test-model-v1'), /session count/);
    await rm(sessions, { recursive: true }); await symlink(receipts, sessions);
    await assert.rejects(collectNativeEvidence(root, join(root, 'usage'), 'agent:writer', undefined, 'test-model-v1'), /directory must be real/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
