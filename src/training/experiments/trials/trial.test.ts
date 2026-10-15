import { describe, expect, it, vi } from 'vitest';
import { readFile, stat, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAtomicGrader, type AtomicRuntime } from '../../graders/atomic/index.js';
import { parseCheckTemplates, parseDecomposition } from '../../graders/decomposition/index.js';
import { artifact } from '../../testing/index.js';
import { trialScore } from '../training/index.js';
import type { Observation } from '../../contracts/execution.js';
import { captureObservation } from '../../capture/index.js';
import { createEvaluationRegistry, result } from '../../evaluation/index.js';
import { runTrial } from '../index.js';
import { capabilities, complete, setup } from './fixture.js';

describe('native trial lifecycle', () => {
  it.each(['before', 'after', 'always'])('refuses durable success when usage persistence rejects %s writing', async failure => {
    const task = await setup(async (input, turn) => {
      const event: Observation = { id: 'usage', source: 'native', seq: 1, type: 'usage',
        trialId: input.trialId, wakeId: turn.id, timestamp: '2026-10-11T00:00:00.000Z',
        usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, reasoningTokens: null, source: 'native' } };
      // Model an adapter's stable retry, including its existing recovery catch.
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await input.onObservation(structuredClone(event)); } catch { /* failed delivery recovery */ }
      }
      return { ...complete, status: 'failed', usage: event.usage! };
    });
    const persist = task.options.persist;
    let attempts = 0;
    task.options.persist = async entry => {
      if (entry.type !== 'observation') return persist(entry);
      attempts++;
      if (failure === 'always' || (failure === 'before' && attempts === 1)) throw new Error('Sink failed');
      await persist(entry);
      if (failure === 'after' && attempts === 1) throw new Error('Sink failed');
    };
    await expect(runTrial(task.options)).rejects.toThrow('Trial evidence persistence failed');
    expect(attempts).toBe(2);
    expect(task.journal.some(entry => entry.type === 'trial.completed')).toBe(false);
    // The raw sink can contain a write whose acknowledgement was lost. Capture
    // collapses that retry into exactly one semantic observation.
    const captured = task.journal.filter(entry => entry.type === 'observation')
      .reduce<Observation[]>((events, entry) => captureObservation(events, entry.payload as Observation), []);
    expect(captured).toHaveLength(failure === 'always' ? 0 : 1);
  });
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
    expect(first.durationMs).toBeGreaterThan(0);
    expect(first.subject).toEqual({ adapterId: task.options.adapter.id, requestedModel: task.options.model, isolation: task.options.adapter.capabilities.isolation });
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
  it('writes the adapter capture as an operator-only trial file and publishes only its path', async () => {
    const task = await setup();
    const diagnostic = { schema: 'paideia.daimon-native.startup-diagnostic.v1', trialId: 'trial',
      reason: 'example.paideia.bootstrap-failed.v1: launch.v2 receipt rejected', exitCode: 1, exitSignal: null,
      redaction: 'withheld' as const,
      frames: [{ stream: 'stderr' as const, schema: 'example.paideia.bootstrap-failed.v1', withheldBy: ['bearer'] }],
      withheld: [{ stream: 'stderr' as const, bytes: 120, lines: 3, frame: 'example.paideia.bootstrap-failed.v1', detectors: ['bearer'] }],
      protectedArtifact: '/run/training/slot/state/paideia-trials/trial-x/child-diagnostics.json' };
    const capture = { basename: 'OPERATOR-ONLY.native-startup-capture.json', content: '{"stderr":"Bearer sk-live-secret"}\n' };
    task.options.adapter = { ...task.options.adapter,
      start: async () => { throw Object.assign(new Error('Native worker failed before readiness'), { diagnostic, capture }); } };
    const report = await runTrial(task.options);
    const file = join(report.paths.root, capture.basename);
    expect(report.diagnostic).toEqual({ ...diagnostic, operatorCapture: file });
    expect(await readFile(file, 'utf8')).toBe(capture.content);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    // It sits beside the trial's own scratch, never in the content store the viewer and reports replay.
    expect(file.startsWith(`${report.paths.root}/`)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('sk-live-secret');
    expect(JSON.stringify(task.journal)).not.toContain('sk-live-secret');
    expect(JSON.stringify(report.snapshot.artifacts)).not.toContain(capture.basename);
  });
  it('refuses an adapter capture whose name is not a plain trial file', async () => {
    const task = await setup();
    task.options.adapter = { ...task.options.adapter, start: async () => {
      throw Object.assign(new Error('Native worker failed before readiness'), {
        diagnostic: { schema: 'x', trialId: 'trial', reason: 'boom', exitCode: 1, exitSignal: null, redaction: 'withheld' as const,
          withheld: [{ stream: 'stderr' as const, bytes: 1, lines: 1, frame: null, detectors: ['bearer'] }] },
        capture: { basename: '../escape.json', content: 'x' } });
    } };
    const report = await runTrial(task.options);
    expect(report.diagnostic?.operatorCapture).toBeUndefined();
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

describe('deferred stage rewards', () => {
  const scoring = { deferred: 'stage-score' as const };

  async function fixture(deferred = true, missing = false) {
    const task = await setup(async () => deferred ? { ...complete, status: 'failed', blocked: 'awaiting-external-input' } : complete);
    task.options.retainDeferredStatus = true;
    const grader = parseAtomicGrader({ schema: 'paideia.atomic-grader.v1', id: 'writing', templates: 'templates.yaml',
      extractor: { provider: 'codex', model: 'test' }, decision: { backend: 'typesafe', model: 'jev-1.0.0', max_spend_usd: 1 }, missing: 'fail',
      aggregation: { method: 'coverage-times-quality', critical_pass_at: 0.8, pass_at: 0.99, obligation_kinds: ['obligation'],
        dimensions: { coverage: { weight: 1, budget: 2 } }, penalties: { critical: 1, major: 0.5, minor: 0.1 } } });
    const templates = parseCheckTemplates({ schema: 'paideia.check-templates.v1', context: { assignment: { role: 'assignment' } },
      templates: [{ id: 'covered', applies_to: 'obligation', type: 'noul', instructions: 'Covered?', criteria: { true: 'Good', false: 'Bad' },
        expected: [true], state: ['unit', 'output.body'], dimension: 'coverage', severity: 'major' }] });
    const receipt = { provider: 'codex', model: 'test', prompt_digest: 'c'.repeat(64), at: '2026-10-14T00:00:00Z' };
    const runtime: AtomicRuntime = { kind: 'atomic', grader, templates, definitionDigest: 'a'.repeat(64), templatesDigest: 'b'.repeat(64), resource: {},
      backend: { identity: async () => ({ backend: 'typesafe', model: grader.decision.model }),
        score: vi.fn<AtomicRuntime['backend']['score']>(async requests => requests.map((request, index) => missing && index === 0
          ? { key: request.key, status: 'missing', probabilities: null, reason: 'Missing answer' }
          : { key: request.key, status: 'ok', probabilities: { true: missing ? 1 : 0.2, false: missing ? 0 : 0.8 } })) },
      extract: async () => ({ decomposition: parseDecomposition({ schema: 'paideia.decomposition.v1', output: { from: 'trial', sha256: 'c'.repeat(64) },
        units: Array.from({ length: missing ? 208 : 1 }, (_, index) => ({ id: `unit-${index}`, kind: 'obligation', text: `Cover fact ${index}.` })),
        extractors: [receipt], audit: { extractor: receipt, missed: [], at: receipt.at } }), receipts: [], judgeCalls: [] }) };
    task.options.prepare = async () => ({ instructions: 'Write', collect: async () => ({
      article: artifact({ body: ['Filed story.'] }),
      assignment: { ...artifact(Array.from({ length: missing ? 208 : 1 }, (_, index) => `Cover fact ${index}.`).join('\n')), name: 'assignment' },
    }) });
    task.options.evaluation.graders = { '/grader.yaml': runtime };
    task.options.record.effectiveStages = [{ id: 'article', checks: [
      { id: 'accepted-filing', eval: 'equals', input: 'output.text', value: 'DONE' },
      { id: 'writing', eval: 'grader', grader: '/grader.yaml', input: 'artifact:article', context: { assignment: 'artifact:assignment' },
        grader_binding: { kind: 'atomic', definitionDigest: runtime.definitionDigest, templatesDigest: runtime.templatesDigest, gates: [] } },
    ], gate: { all: [{ passed: 'accepted-filing' }] }, score: { linear: { writing: 1 } } }];
    return { ...task, runtime };
  }

  it.each([false, true])('uses atomic numeric fail grades only as score terms (one missing answer: %s)', async missing => {
    for (const deferred of [false, true]) {
      const task = await fixture(deferred, missing);
      const report = await runTrial(task.options);
      const writing = report.evaluation.checks.writing!;
      expect(writing.status).toBe('fail');
      expect(writing.atomicGrading).toMatchObject({ status: 'fail', coverage: missing ? 207 / 208 : 1 });
      expect(writing.score).toBeCloseTo(missing ? (207 / 208) * 0.75 : 0.16);
      expect(writing.score).toBeLessThan(1);
      expect(report.evaluation.status).toBe('pass');
      expect(report.evaluation.stages[0]!.score).toMatchObject({ lower: writing.score, missingWeight: 0 });
      expect(report.status).toBe(deferred ? 'fail' : 'pass');
      expect(report.preDeferralStatus).toBe(deferred ? 'pass' : undefined);
      expect(trialScore(report)).toBe(deferred ? 0 : writing.score);
      expect(trialScore(report, { deferred: 'zero' })).toBe(trialScore(report));
      expect(trialScore(report, scoring)).toBe(writing.score);
      expect(report.status).toBe(deferred ? 'fail' : 'pass');
    }
  });

  it('retains default report shape and never guesses why a legacy deferred report failed', async () => {
    const task = await fixture(); delete task.options.retainDeferredStatus;
    const report = await runTrial(task.options);
    expect(Object.hasOwn(report, 'preDeferralStatus')).toBe(false);
    expect(trialScore(report, scoring)).toBe(0);
  });

  it.each(['fail', 'unknown', 'error'] as const)('refuses a deferred reward when the stage gate is %s', async status => {
    const task = await fixture();
    task.options.record.effectiveStages[0]!.gate = status === 'fail'
      ? { eval: 'equals', input: 'output.text', value: 'WRONG' }
      : status === 'unknown' ? { passed: 'unobserved' } : { eval: 'unregistered' };
    const report = await runTrial(task.options);
    expect(report.preDeferralStatus).toBe(status);
    expect(report.status).toBe(status === 'error' ? 'error' : 'fail');
    if (status === 'error') expect(() => trialScore(report, scoring)).toThrow('unscorable');
    else expect(trialScore(report, scoring)).toBe(0);
  });

  it.each(['fail', 'unknown'] as const)('includes a %s turn gate in the pre-deferral verdict', async status => {
    const task = await fixture();
    task.options.record.turns = [{ id: 'wake', input: { prompt: 'Write' }, checks: [status === 'fail'
      ? { eval: 'equals', input: 'output.text', value: 'WRONG' } : { eval: 'contains-any', input: 'artifact:unobserved', values: ['done'] }] }];
    const report = await runTrial(task.options);
    expect(report.evaluation.status).toBe('pass');
    expect(report.preDeferralStatus).toBe(status);
    expect(trialScore(report, scoring)).toBe(0);
  });

  it('rejects missing score coverage and masked atomic infrastructure failure in the opt-in path', async () => {
    const task = await fixture();
    task.options.record.effectiveStages[0]!.checks.push({ id: 'missing', passed: 'unobserved' });
    task.options.record.effectiveStages[0]!.score!.linear.missing = 1;
    const incomplete = await runTrial(task.options);
    expect(incomplete.preDeferralStatus).toBe('pass');
    expect(() => trialScore(incomplete, scoring)).toThrow('coverage');
    expect(trialScore(incomplete)).toBe(0);
    const broken = await fixture();
    vi.mocked(broken.runtime.backend.score).mockRejectedValue(new Error('Provider unavailable'));
    const failed = await runTrial(broken.options);
    expect(failed.preDeferralStatus).toBe('pass');
    expect(failed.evaluation.checks.writing!.atomicGrading!.status).toBe('error');
    expect(() => trialScore(failed, scoring)).toThrow('atomic grading measurement');
  });
});
