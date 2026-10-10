import { afterEach, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { nativeDeferredTrial, unregisteredSidecar } from './deferred-trial.js';
import { bindTerminalEvidence } from './lifecycle.js';
import { launchFixture, traceFixture } from '../test-fixtures.js';
import type { TerminalEvidence } from '../worker/index.js';
import type { TerminalEvidenceMissing } from '../../../contracts/execution.js';
import { trialScore } from '../../../experiments/index.js';

vi.mock('./sandbox.js', () => ({ verifyChildSandbox: vi.fn(async () => undefined) }));
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/**
 * The last named blocker on a training loop. A trial that defers runs several
 * wakes, each one publishes its own terminal frame, and the reader kept exactly
 * one verdict: whichever delivery answered last. So a continuation whose own
 * frame names no closed execution erased the first wake's frame — which had
 * bound, over a closed trace, on a runtime this same stop proves quiet — and the
 * trial reported `unevidenced`: nothing at all to score.
 *
 * The boundary this straddles is the worker/parent HTTP seam. Each `/trial/run`
 * reply is ONE wake's account, and the parent holds the only record of the
 * others; treating the newest reply as the trial's whole evidence threw away
 * every earlier account the moment a later delivery went wrong.
 */
it('scores a deferred trial from its admissible first wake when the continuation\'s own frame does not bind', async () => {
  const { report, turn, deliveries, root } = await nativeDeferredTrial('blocked-always-unbound-continuation');
  roots.push(root);
  // Two wakes really ran: the assignment and the continuation the budget admitted.
  expect(deliveries).toBe(1);
  expect(turn).toMatchObject({ status: 'failed', blocked: 'awaiting-external-input' });
  expect(turn.usage?.inputTokens).toBe(200);
  // Quiet AND scorable, and the receipt names the wake the verdict rests on.
  expect(report.stop).toMatchObject({ state: 'acknowledged', quiescence: 'confirmed', evidenced: 'task' });
  expect(report.stop?.unevidenced).toBeUndefined();
  expect(report.stop?.unconfirmed).toBeUndefined();
  expect(report.error).not.toContain('want of terminal evidence');
  // Deferred is still never success: a measured zero, not an unscorable run.
  expect(report.execution).toBe('deferred');
  expect(report.status).toBe('fail');
  expect(trialScore(report)).toBe(0);
});

/**
 * The guard that keeps selection from becoming "score anything that ever bound".
 * Every wake of this trial published a frame naming an execution nothing answers
 * to, so there is no admissible frame anywhere in it — and the refusal says which
 * wake it read last and why, rather than the bare name it published before.
 */
it('stays unscorable when no wake of a multi-wake trial produced an admissible frame', async () => {
  const { report, deliveries, root } = await nativeDeferredTrial('blocked-always-unbound');
  roots.push(root);
  expect(deliveries).toBe(1);
  expect(report.stop).toMatchObject({ state: 'acknowledged', quiescence: 'confirmed', unevidenced: 'terminal-unbound' });
  expect(report.stop?.evidenced).toBeUndefined();
  expect(report.stop?.detail).toContain('terminal-unbound');
  expect(report.stop?.detail).toContain('answer-0');
  // The trial names the failing wake beside the cause, so an operator reading the
  // report alone can tell which delivery it has to go and look at.
  expect(report.error).toContain('Native trial unscorable for want of terminal evidence (terminal-unbound) on wake answer-0');
  expect(report.execution).toBe('failed');
  expect(() => trialScore(report)).toThrow('failed in infrastructure');
});

/**
 * Selection must not become suppression. A continuation that failed to bind is a
 * real account of that wake: the trial scored from an earlier frame, and the
 * later one's own verdict still has to be readable afterwards — durably on the
 * receipt, because the worker's own artifacts live on a control root a training
 * slot puts on tmpfs, and in its own file for as long as that root exists.
 */
it('keeps the continuation\'s own unbound verdict after scoring an earlier wake', async () => {
  const { report, root } = await nativeDeferredTrial('blocked-always-unbound-continuation');
  roots.push(root);
  // The scored wake and the failed one, both named, in the order they were delivered.
  expect(report.stop?.wakes).toEqual([{ wakeId: 'task' }, { wakeId: 'answer-0', unevidenced: 'terminal-unbound' }]);
  expect(report.stop?.detail).toContain('scored from wake task, not wake answer-0 (terminal-unbound)');
  // Nothing above was read out of a sidecar artifact: these trials register none,
  // so the verdict is exactly the subject's own evidence.
  await expect(unregisteredSidecar()).rejects.toThrow('unregistered sidecar');
  // The worker's own per-wake frames are the other half of this, and they are a
  // worker-side artifact: `worker/control-continuation.test.ts` reads them back.
});


it.each(['blocked-always-unbound-continuation-foreign', 'blocked-always-failed-continuation-foreign'])(
  'invalidates earlier evidence when %s carries a foreign-agent trace', async mode => {
    const { report, root } = await nativeDeferredTrial(mode);
    roots.push(root);
    expect(report.stop).toMatchObject({ state: 'acknowledged', quiescence: 'confirmed', unevidenced: 'terminal-unbound' });
    expect(report.stop?.evidenced).toBeUndefined();
    expect(report.stop?.wakes).toEqual([{ wakeId: 'task' }, { wakeId: 'answer-0', unevidenced: 'terminal-unbound' }]);
    expect(report.execution).toBe('failed');
    expect(() => trialScore(report)).toThrow('failed in infrastructure');
  });


it.each(['missing', 'failed'] as const)('seals the trial before returning for a %s named trace with foreign history', async kind => {
  const fixture = await launchFixture();
  roots.push(fixture.root);
  let sealed: TerminalEvidenceMissing | undefined;
  const seal = (fault: TerminalEvidenceMissing): void => { sealed ??= fault; };
  const trace = traceFixture();
  const frame = { schema: 'paideia.daimon-native.trial.v1', trialId: fixture.input.trialId,
    agentId: fixture.launch.agent.id, model: fixture.launch.agent.model, configSha256: fixture.launch.configSha256,
    wakeId: 'task', executionId: trace.turn_id, native: { traces: [trace] },
    receipt: { agent_id: fixture.launch.agent.id, delivery_id: `${fixture.input.trialId}:task`, execution_id: trace.turn_id },
    activity: { executions: [] } } as unknown as TerminalEvidence;
  const first = { wakeId: 'task', unevidenced: 'terminal-absent' as TerminalEvidenceMissing | undefined };
  bindTerminalEvidence(first, frame, fixture.launch, fixture.input.trialId, seal);
  expect(first.unevidenced).toBeUndefined();
  const continuation = { ...frame, wakeId: 'answer', executionId: kind === 'missing' ? 'missing' : trace.turn_id,
    receipt: { ...frame.receipt!, delivery_id: `${fixture.input.trialId}:answer` }, native: { ...frame.native,
      traces: [{ ...trace, status: 'failed' as const }, { ...trace, turn_id: 'foreign', agent_id: 'foreign-agent' }] } };
  expect(() => bindTerminalEvidence({ wakeId: 'answer' }, continuation, fixture.launch, fixture.input.trialId, seal)).toThrow('identity mismatch');
  expect(sealed).toBe('terminal-unbound');
});


it.each(['failed-first', 'completed-first', 'missing-named', 'duplicate-history'] as const)(
  'seals the whole trial for duplicate execution traces (%s) after an admissible wake', async order => {
    const fixture = await launchFixture();
    roots.push(fixture.root);
    let sealed: TerminalEvidenceMissing | undefined;
    const seal = (fault: TerminalEvidenceMissing): void => { sealed ??= fault; };
    const trace = traceFixture();
    const frame = { schema: 'paideia.daimon-native.trial.v1', trialId: fixture.input.trialId,
      agentId: fixture.launch.agent.id, model: fixture.launch.agent.model, configSha256: fixture.launch.configSha256,
      wakeId: 'task', executionId: trace.turn_id, native: { traces: [trace] },
      receipt: { agent_id: fixture.launch.agent.id, delivery_id: `${fixture.input.trialId}:task` },
      activity: { executions: [] } } as unknown as TerminalEvidence;
    const first = { wakeId: 'task', unevidenced: 'terminal-absent' as TerminalEvidenceMissing | undefined };
    bindTerminalEvidence(first, frame, fixture.launch, fixture.input.trialId, seal);
    expect(first.unevidenced).toBeUndefined();
    expect(sealed).toBeUndefined();
    const failed = { ...trace, status: 'failed' as const };
    const traces = order === 'completed-first' ? [trace, failed] : [failed, trace];
    const executionId = order === 'missing-named' ? 'missing' : order === 'duplicate-history' ? 'new' : trace.turn_id;
    if (order === 'duplicate-history') traces.push({ ...trace, turn_id: 'new' });
    const continuation = { ...frame, wakeId: 'answer', executionId,
      receipt: { ...frame.receipt!, delivery_id: `${fixture.input.trialId}:answer` }, native: { ...frame.native, traces } };
    const wake = { wakeId: 'answer', unevidenced: undefined as TerminalEvidenceMissing | undefined };
    expect(() => bindTerminalEvidence(wake, continuation, fixture.launch, fixture.input.trialId, seal)).toThrow('ambiguous');
    expect(wake.unevidenced).toBe('terminal-ambiguous');
    expect(sealed).toBe('terminal-ambiguous');
  });
