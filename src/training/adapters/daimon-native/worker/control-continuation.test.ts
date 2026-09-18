import { test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkerController } from './control.js';
import { wakeEvidenceFile } from './evidence.js';
import { configFixture, receiptFixture, traceFixture } from '../test-fixtures.js';
import type { NativeHost, WorkerOptions } from './types.js';

test('worker admits a real second external delivery, isolates its evidence, and retains task budget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-continuation-'));
  try {
    await mkdir(join(root, 'runtime/telemetry'), { recursive: true });
    await mkdir(join(root, 'runtime/.codex/sessions'), { recursive: true });
    await mkdir(join(root, 'control'));
    await writeFile(join(root, 'runtime/.codex/sessions/unit.jsonl'), `${JSON.stringify({ type: 'turn_context', payload: { model: 'test-model-v1' } })}\n`);
    let count = 0, stops = 0;
    let receipt = receiptFixture();
    const deliveries: unknown[] = [];
    const host = {
      async accept(request: {delivery_id: string; event: {text: string}}) {
        deliveries.push(request); count++;
        const execution = `${count}1111111-1111-4111-8111-111111111111`;
        receipt = { ...receiptFixture(), delivery_id: request.delivery_id, execution_id: execution,
          state: count === 1 ? 'accepted' : 'completed', deferred: count === 1 };
        await appendFile(join(root, 'control/usage.jsonl'), `${JSON.stringify({ v: 'noopolis.daimon.turn-usage.v1', agent: 'agent:writer', wake: execution,
          engine: 'codex', at: '2026-09-13T00:00:01.000Z', input: 10 * count, output: 2, cache_read: 0, total: 10 * count + 2, complete: true })}\n`);
        await appendFile(join(root, 'runtime/telemetry/turns.ndjson'), `${JSON.stringify({ ...traceFixture(), turn_id: execution })}\n`);
        return { state: 'accepted', acceptance_id: receipt.acceptance_id };
      },
      wakeReceipt: async () => receipt,
      activityV2: async () => ({ executions: [], items: [{ ...receipt, active: false }] }),
      availability: async () => ({ state: 'ready', agents: [{ agent_id: 'agent:writer' }] }),
      stop: async () => { stops++; return { state: 'stopped' }; },
    } as unknown as NativeHost;
    const options: WorkerOptions = { launch: '/launch', config: '/config', configSha256: 'a'.repeat(64), controlRoot: join(root, 'control'),
      tokenFile: '/token', evidence: join(root, 'control/evidence.json'), trialId: 'trial', timeoutMs: 1000, scheduleOverride: 'disabled' };
    const controller = createWorkerController(host, configFixture(root), options, 'token');
    const first = await controller.run('task', 'Assigned work', { maxExternalDeliveries: 1 });
    expect(first.blocked).toBe('awaiting-external-input');
    expect(first.status).toBe('failed'); expect(stops).toBe(0);
    const answer = 'A genuinely supplied external answer';
    const second = await controller.run('answer', answer, { source: { kind: 'transport', id: 'answer-message',
      sha256: `sha256:${createHash('sha256').update(answer).digest('hex')}` } });
    expect(second.status, second.error).toBe('completed');
    expect(second.native.traces).toHaveLength(1);
    expect(second.native.usage).toHaveLength(1);
    expect(first.native.usage[0]!.input).toBe(10); expect(second.native.usage[0]!.input).toBe(20);
    expect(deliveries).toHaveLength(2);
    expect(JSON.parse(await readFile(options.evidence, 'utf8')).executionId).toBe(second.executionId);
    // Each wake also files its own frame, because renaming over one file left a
    // continued trial holding only its last delivery's account: the assignment's
    // frame — the one that bound over a closed trace — no longer existed. Nothing
    // is merged; each file is exactly one wake's own frame.
    const filed = (await readdir(join(root, 'control'))).filter(name => name.startsWith('evidence')).sort();
    expect(filed).toEqual(['evidence.1.json', 'evidence.2.json', 'evidence.json']);
    const frames = await Promise.all(['evidence.1.json', 'evidence.2.json']
      .map(async name => JSON.parse(await readFile(join(root, 'control', name), 'utf8')) as { wakeId: string; executionId: string }));
    expect(frames.map(frame => frame.wakeId)).toEqual(['task', 'answer']);
    expect(frames.map(frame => frame.executionId)).toEqual([first.executionId, second.executionId]);
    expect(wakeEvidenceFile('/control/evidence', 3)).toBe('/control/evidence.3');
    expect(() => wakeEvidenceFile(options.evidence, 0)).toThrow('delivery ordinal');
    await expect(controller.run('extra', answer)).rejects.toThrow('exactly one');
    await controller.stop(); expect(stops).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
