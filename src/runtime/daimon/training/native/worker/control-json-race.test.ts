import { expect, test } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkerController } from './control.js';
import { activityFixture, configFixture, executionId, receiptFixture, traceFixture } from '../test-fixtures.js';
import type { NativeHost, WorkerOptions } from './types.js';

async function race(kind: string, initial: string, permanent = false) {
  const root = await mkdtemp(join(tmpdir(), 'native-control-json-'));
  let publishing: Promise<void> | undefined;
  try {
    const home = join(root, 'runtime'), control = join(root, 'control');
    await Promise.all([mkdir(control), mkdir(join(home, 'telemetry'), { recursive: true }),
      mkdir(join(home, '.codex/sessions'), { recursive: true }), mkdir(join(home, 'tool-state'), { recursive: true })]);
    const trace = traceFixture();
    const receipt = receiptFixture();
    const rows: Record<string, { file: string; value: unknown; stream?: boolean }> = {
      telemetry: { file: join(home, 'telemetry/turns.ndjson'), value: trace, stream: true },
      usage: { file: join(control, 'usage.jsonl'), stream: true, value: { v: 'noopolis.daimon.turn-usage.v1', agent: 'agent:writer',
        wake: executionId, engine: 'codex', at: trace.completed_at, input: 1, output: 1, cache_read: 0, total: 2, complete: true } },
      model: { file: join(home, '.codex/sessions/unit.jsonl'), stream: true, value: { type: 'turn_context', payload: { model: 'test-model-v1' } } },
      tool: { file: join(home, 'tool-state', `${'a'.repeat(64)}.json`), value: { agent_id: 'agent:writer', engine: 'codex', kind: 'mcp',
        delivery_id: 'tool', at: trace.completed_at, server: 'fixture', tool: 'read', is_error: false } },
      receipt: { file: join(control, 'acceptance.json'), value: receipt },
      activity: { file: join(control, 'activity.json'), value: activityFixture() },
      availability: { file: join(control, 'availability.json'), value: { state: 'running', agents: [{ agent_id: 'agent:writer' }] } },
    };
    const selected = rows[kind]!;
    const bytes = JSON.stringify(selected.value) + (selected.stream ? '\n' : '');
    const host = {
      accept: async () => {
        for (const [name, row] of Object.entries(rows)) await writeFile(row.file, name === kind ? initial : JSON.stringify(row.value) + (row.stream ? '\n' : ''));
        if (!permanent) publishing = new Promise<void>(resolve => setTimeout(resolve, 75)).then(() => writeFile(selected.file, bytes));
        return { state: 'accepted', acceptance_id: receipt.acceptance_id };
      },
      // These reads model the native host's own JSON.parse, beyond Paideia's file readers.
      wakeReceipt: async () => JSON.parse(await readFile(rows.receipt!.file, 'utf8')),
      activityV2: async () => JSON.parse(await readFile(rows.activity!.file, 'utf8')),
      availability: async () => JSON.parse(await readFile(rows.availability!.file, 'utf8')),
      stop: async () => ({ state: 'stopped' }),
    } as unknown as NativeHost;
    const options: WorkerOptions = { launch: '/launch', config: '/config', configSha256: 'a'.repeat(64), controlRoot: control,
      tokenFile: '/token', evidence: join(control, 'evidence.json'), trialId: 'trial', timeoutMs: 6000, scheduleOverride: 'disabled' };
    const result = await createWorkerController(host, configFixture(root), options, 'unit-token').run('wake', 'Assigned work');
    const persisted = JSON.parse(await readFile(options.evidence, 'utf8'));
    expect(persisted).toEqual(result);
    return result;
  } finally { await publishing; await rm(root, { recursive: true, force: true }); }
}

test.each(['telemetry', 'usage', 'model', 'tool', 'receipt', 'activity', 'availability'])(
  'binds the closed execution after truncated %s JSON completes', async kind => {
    const result = await race(kind, '{"partial":');
    expect(result.status, result.error).toBe('completed');
    expect(result.executionId).toBe(executionId);
    expect(result.native.traces[0]?.turn_id).toBe(executionId);
    expect(result.coverage.find(row => row.channel === 'usage')?.completeness).toBe('complete');
  });

test.each(['telemetry', 'usage', 'model', 'tool', 'receipt'])('binds after an initially empty %s file completes', async kind => {
  const result = await race(kind, '');
  expect(result.status, result.error).toBe('completed');
  expect(result.executionId).toBe(executionId);
});

test.each([
  ['telemetry', 'closed trace telemetry'], ['usage', 'token usage ledger'], ['model', 'Codex model context session'],
  ['tool', 'tool receipt'], ['receipt', 'wake acceptance receipt'], ['activity', 'activity acceptance/batch snapshot'],
  ['availability', 'availability snapshot'],
])('permanent %s corruption fails with its file kind and no content', async (kind, label) => {
  const result = await race(kind, '{private-canary}', true);
  expect(result.status).toBe('failed');
  expect(result.error).toContain(`Native ${label} JSON did not settle before deadline`);
  expect(result.error).not.toContain('private-canary');
});

test('child HTTP observations share settled readers and host mutations are forwarded exactly once', async () => {
  let accepts = 0, starts = 0, stops = 0, health = 0, reads = 0;
  const host = {
    start: async () => { starts++; }, stop: async () => { stops++; }, health: async () => { health++; return { state: 'running' }; },
    accept: async () => { accepts++; return { state: 'rejected', code: 'invalid_request' }; },
    wakeReceipt: async () => { if (++reads < 2) throw new SyntaxError('private-canary'); return receiptFixture(); },
    activityV2: async () => activityFixture(), availability: async () => ({ state: 'running', agents: [] }),
  } as unknown as NativeHost;
  const controller = createWorkerController(host, configFixture('/fixture'), { timeoutMs: 1000, controlRoot: '/fixture/control' } as WorkerOptions, 'unit-token');
  await controller.host.start(); await controller.host.stop(); await controller.host.health(); await controller.host.accept({});
  expect(await controller.host.wakeReceipt('unit-token', 'acceptance')).toEqual(receiptFixture());
  expect(await controller.host.activityV2('unit-token')).toEqual(activityFixture());
  expect(await controller.host.availability('unit-token')).toEqual({ state: 'running', agents: [] });
  expect({ starts, stops, health, accepts, reads }).toEqual({ starts: 1, stops: 1, health: 1, accepts: 1, reads: 2 });
});

test.each([['usage', 'token usage ledger'], ['telemetry', 'closed trace telemetry'], ['model', 'Codex model context session']])(
  'a permanently empty %s file after execution closure is a named failure', async (kind, label) => {
  const result = await race(kind, '', true);
  expect(result.status).toBe('failed');
  if (kind !== 'telemetry') expect(result.executionId).toBe(executionId);
  expect(result.error).toContain(`Native ${label} JSON did not settle before deadline`);
});
