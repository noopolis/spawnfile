import { describe, expect, it } from 'vitest';
import { writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createEvaluationRegistry, result } from '../../evaluation/index.js';
import { runTrial } from '../index.js';
import { capabilities, complete, setup } from './fixture.js';

describe('native trial lifecycle', () => {
  it('persists actual completion, immutable outputs and native evidence in a fresh workspace', async () => {
    const task = await setup(async (input, turn) => {
      expect(input.instructions).toBe('original instructions'); expect(input.protectedPaths).toContain(task.options.root); expect(input.protectedPaths).toContain(join(input.runtimeHomePath, '..', 'control').replace('/runtime/..', ''));
      const event = { id: 'event', source: 'native', seq: 1, type: 'output' as const, text: 'DONE',
        trialId: input.trialId, wakeId: turn.id, timestamp: new Date().toISOString() };
      await input.onObservation(event); await input.onObservation(event);
      await writeFile(join(input.workspacePath, 'article.json'), '{"body":"Filed"}');
      return complete;
    });
    task.options.record.outputs = { article: 'article.json' };
    const first = await runTrial(task.options); const second = await runTrial({ ...task.options, id: 'second' });
    expect(first.status).toBe('pass'); expect(first.execution).toBe('completed');
    expect(first.snapshot.events).toHaveLength(1); expect(first.snapshot.artifacts.article!.value).toEqual({ body: 'Filed' });
    expect(first.paths.workspace).not.toBe(second.paths.workspace);
    expect(task.journal.filter(row => row.type === 'trial.completed')).toHaveLength(2);
  });
  it('persists an adapter-published startup diagnostic durably and names its reason in the report', async () => {
    const task = await setup();
    const diagnostic = { schema: 'paideia.daimon-native.startup-diagnostic.v1', trialId: 'trial',
      reason: 'unit missing native library', exitCode: 1, exitSignal: null, redaction: 'applied' as const,
      streams: { stdout: '', stderr: 'boom', truncated: { stdout: false, stderr: false } },
      protectedArtifact: '/run/training/slot/state/paideia-trials/trial-x/child-diagnostics.json' };
    task.options.adapter = { ...task.options.adapter,
      start: async () => { throw Object.assign(new Error('Native worker failed before readiness: unit missing native library'), { diagnostic }); } };
    const report = await runTrial(task.options);
    expect(report.execution).toBe('failed');
    expect(report.error).toContain('unit missing native library');
    expect(report.diagnostic).toEqual(diagnostic);
    // The record reaches the durable sink, not only the returned report.
    expect(task.journal.filter(row => row.type === 'subject.startup-diagnostic')).toEqual([{ type: 'subject.startup-diagnostic', payload: diagnostic }]);
  });
  it('ignores a startup failure that publishes no documented diagnostic', async () => {
    const task = await setup();
    task.options.adapter = { ...task.options.adapter, start: async () => { throw new Error('opaque startup failure'); } };
    const report = await runTrial(task.options);
    expect(report.execution).toBe('failed');
    expect(report.error).toBe('opaque startup failure');
    expect(report.diagnostic).toBeUndefined();
    expect(task.journal.some(row => row.type === 'subject.startup-diagnostic')).toBe(false);
  });
  it('stops on a decisive mechanical violation, retaining cancellation-tail evidence', async () => {
    const task = await setup(async (input, turn) => {
      await input.onObservation({ id: 'forbidden', source: 'native', seq: 1, type: 'tool.dispatch', tool: 'forbidden', callId: 'call', args: {},
        trialId: input.trialId, wakeId: turn.id, timestamp: new Date().toISOString() });
      expect(input.signal!.aborted).toBe(true);
      await input.onObservation({ id: 'tail', source: 'native', seq: 2, type: 'usage', usage: null as never,
        trialId: input.trialId, wakeId: turn.id, timestamp: new Date().toISOString() });
      return complete;
    });
    task.options.record.live.checks = [{ id: 'boundary', on: 'event', on_fail: 'stop', not: { eval: 'tool-called', tool: 'forbidden' } }];
    const report = await runTrial(task.options);
    expect(report.status).toBe('fail'); expect(report.evaluation.status).toBe('skipped'); expect(report.execution).toBe('interrupted');
    expect(report.snapshot.events.at(-1)!.id).toBe('tail'); expect(task.stops).toBe(1); expect(report.stop!.state).toBe('acknowledged');
    expect(task.journal.findIndex(row => row.type === 'observation')).toBeLessThan(task.journal.findIndex(row => row.type === 'live.evaluation'));
  });
  it('retains a decisive task failure when a native adapter rejects with AbortError', async () => {
    const task = await setup(async (input, turn) => {
      await input.onObservation({ id: 'forbidden', source: 'native', seq: 1, type: 'tool.dispatch', tool: 'forbidden', callId: 'call', args: {},
        trialId: input.trialId, wakeId: turn.id, timestamp: new Date().toISOString() });
      input.signal!.throwIfAborted();
      throw new Error('Must have been aborted');
    });
    task.options.record.live.checks = [{ id: 'boundary', on: 'event', on_fail: 'stop', not: { eval: 'tool-called', tool: 'forbidden' } }];
    const report = await runTrial(task.options);
    expect(report.status).toBe('fail'); expect(report.execution).toBe('interrupted');
    expect(report.decisiveFailure!.id).toBe('boundary');
  });
  it('cannot pass an absent forbidden call from partial coverage', async () => {
    const task = await setup(async () => ({ ...complete, coverage: [{ channel: 'tools', completeness: 'partial', ordering: 'source' }, complete.coverage[1]!] }));
    task.options.record.live.checks = [{ id: 'boundary', on: 'event', on_fail: 'stop', not: { eval: 'tool-called', tool: 'forbidden' } }];
    expect((await runTrial(task.options)).status).toBe('unknown'); expect(task.stops).toBe(1);
  });
  it('keeps native continuity and trusted bindings within one record and namespaces turn checks', async () => {
    const stimuli: string[] = [];
    const task = await setup(async (input, turn) => {
      stimuli.push(turn.text);
      await input.onObservation({ id: turn.id, source: 'native', seq: stimuli.length, type: 'output', text: turn.id === 'request' ? 'r1' : 'DONE',
        trialId: input.trialId, wakeId: turn.id, timestamp: new Date().toISOString() });
      return { ...complete, text: turn.id === 'request' ? 'r1' : 'DONE' };
    });
    task.options.record.turns = [
      { id: 'request', input: { prompt: 'Request evidence' }, bind: { request: { event: 'output', value: 'event.text', distinct: 'event.id', cardinality: 'one' } },
        checks: [{ id: 'done', eval: 'equals', input: 'output.text', value: 'r1' }] },
      { id: 'delivery', after: { turn: 'request', outcome: 'completed' }, input: { message: { reply: { binding: 'request' } } },
        checks: [{ id: 'done', eval: 'equals', input: 'output.text', value: 'DONE' }, { id: 'prior', passed: 'done' }] },
    ]; delete task.options.record.input;
    const report = await runTrial(task.options);
    expect(report.status).toBe('pass'); expect(task.starts).toBe(1); expect(stimuli[1]).toContain('"reply":"r1"');
    expect(report.turns.map(turn => turn.checks[0]!.id)).toEqual(['done', 'done']);
  });
  it('does not continue stimuli after a failed mechanical turn gate', async () => {
    const task = await setup();
    task.options.record.turns = [{ id: 'one', input: { prompt: 'first' }, checks: [{ id: 'gate', eval: 'equals', input: 'output.text', value: 'wrong' }] },
      { id: 'two', input: { prompt: 'later' } }];
    const report = await runTrial(task.options);
    expect(report.turns).toHaveLength(1); expect(report.status).toBe('fail'); expect(report.error).toContain('gate');
  });
  it('rejects missing capabilities before native work and makes preparation/native failures explicit', async () => {
    const task = await setup();
    for (const patch of [{ id: '' }, { model: '' }, { record: { ...task.options.record, input: undefined } }]) {
      await expect(runTrial({ ...task.options, ...patch })).rejects.toThrow();
    }
    await expect(runTrial({ ...task.options, adapter: { ...task.options.adapter, capabilities: { ...capabilities, protectedPaths: false } } })).rejects.toThrow('protection');
    task.options.record.turns = [{ id: 'one', input: { prompt: 'a' } }, { id: 'two', input: { prompt: 'b' } }];
    await expect(runTrial({ ...task.options, adapter: { ...task.options.adapter, capabilities: { ...capabilities, multiTurn: false } } })).rejects.toThrow('multiple');
    delete task.options.record.turns;
    task.options.record.live.checks = [{ id: 'stop', on: 'event', on_fail: 'stop', not: { eval: 'tool-called', tool: 'bad' } }];
    await expect(runTrial({ ...task.options, adapter: { ...task.options.adapter, capabilities: { ...capabilities, cancellation: 'none' } } })).rejects.toThrow('cancellation');
    expect(task.starts).toBe(0);
    task.options.record.live.checks = [];
    const failed = await runTrial({ ...task.options, prepare: async () => { throw 'preparation failed'; } });
    expect(failed.execution).toBe('failed'); expect(failed.error).toBe('preparation failed');
    await expect(runTrial({ ...task.options, persist: async () => { throw new Error('disk full'); } })).rejects.toThrow('persistence');
    const native = await setup(async () => ({ ...complete, status: 'failed', error: 'native failure' }));
    expect((await runTrial(native.options)).execution).toBe('failed');
    const cancelled = await setup(async () => ({ ...complete, status: 'cancelled' }));
    expect((await runTrial(cancelled.options)).execution).toBe('interrupted');
  });
  it('records malicious output collection and host callback failures as durable failures', async () => {
    const malicious = await setup(async input => {
      await symlink('/etc/passwd', join(input.workspacePath, 'article.json'));
      return complete;
    });
    malicious.options.record.outputs = { article: 'article.json' };
    const report = await runTrial(malicious.options);
    expect(report.execution).toBe('failed'); expect(report.error).toContain('collection failed');
    expect(report.snapshot.artifacts).toEqual({}); expect(report.stop!.state).toBe('acknowledged');
    expect(malicious.journal.at(-1)!.type).toBe('trial.completed');
    const badEvent = await setup(async (input, turn) => {
      await input.onObservation({ id: 'bad', source: 'native', seq: 1, type: 'output', text: 'x',
        trialId: 'other', wakeId: turn.id, timestamp: new Date().toISOString() });
      return complete;
    });
    expect((await runTrial(badEvent.options)).execution).toBe('failed');
    const cancelled = await setup(); const abort = new AbortController(); abort.abort();
    const stopped = await runTrial({ ...cancelled.options, signal: abort.signal });
    expect(stopped.execution).toBe('interrupted'); expect(cancelled.starts).toBe(0);
  });
  it('rejects semantic dependencies in turn gates before creating a native session', async () => {
    const task = await setup();
    task.options.record.turns = [{ id: 'one', input: { prompt: 'task' },
      checks: [{ id: 'tone', not: { any: [{ eval: 'llm-rubric' }] } }] }];
    await expect(runTrial(task.options)).rejects.toThrow('mechanical');
    expect(task.starts).toBe(0);
  });
  it('serializes concurrent native observations without dropping either event', async () => {
    const task = await setup(async (input, turn) => {
      await Promise.all([1, 2].map(seq => input.onObservation({ id: `event-${seq}`, source: 'native', seq, type: 'output', text: 'DONE',
        trialId: input.trialId, wakeId: turn.id, timestamp: new Date().toISOString() })));
      return complete;
    });
    const report = await runTrial(task.options);
    expect(report.snapshot.events.map(event => event.id)).toEqual(['event-1', 'event-2']);
  });
  it('keeps semantic advice from gating native continuation', async () => {
    let release: (() => void) | undefined; let reachedEnd = false;
    const task = await setup(async (input, turn) => {
      await input.onObservation({ id: 'progress', source: 'native', seq: 1, type: 'output', text: 'draft',
        trialId: input.trialId, wakeId: turn.id, timestamp: new Date().toISOString() });
      reachedEnd = true; release?.(); return complete;
    });
    task.options.registry = createEvaluationRegistry({ advisory: { definition: { version: '1', kind: 'semantic', incremental: true, stopProof: false, validate() {} },
      evaluate: async (_check, context) => { if (!context.snapshot.closed) await new Promise<void>(resolve => { release = resolve; }); return result('fail', 'rough prose', context.snapshot.closed); } } });
    task.options.record.live.checks = [{ id: 'advice', on: 'event', eval: 'advisory', on_fail: 'continue' }];
    const report = await runTrial(task.options);
    expect(reachedEnd).toBe(true); expect(report.status).toBe('pass'); expect(task.stops).toBe(1);
  });
});
