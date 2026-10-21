import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AMBIGUOUS_NATIVE_EXECUTION, AMBIGUOUS_WAKE_EXECUTION, claimedExecution, declaredLimitStop, disposedWakeExecution, executionClosed } from './execution.js';
import type { NativeUsage } from '../types.js';
import { activityFixture, executionId, receiptFixture, traceFixture } from '../../test-fixtures.js';

test('completed inbox receipt cannot close a running execution or substitute for telemetry', () => {
  assert.equal(executionClosed(activityFixture(true), receiptFixture(), [traceFixture()], 'agent:writer', executionId), undefined);
  assert.equal(executionClosed(activityFixture(), receiptFixture(), [], 'agent:writer', executionId), undefined);
  assert.equal(executionClosed(activityFixture(), receiptFixture(), [traceFixture()], 'agent:writer', executionId), executionId);
  assert.throws(() => executionClosed({ ...activityFixture(), executions: undefined }, receiptFixture(), [traceFixture()], 'agent:writer', executionId), /authority/);
  assert.throws(() => executionClosed(activityFixture(), { ...receiptFixture(), execution_id: 'foreign' }, [traceFixture()], 'agent:writer', executionId), /identity/);
  assert.throws(() => executionClosed(activityFixture(), { ...receiptFixture(), agent_id: 'other' }, [traceFixture()], 'agent:writer', executionId), /identity/);
});

/**
 * The property the single-trace rule was standing in for. A trial whose subject
 * deferred runs its continuations as further wakes, so three closed traces is its
 * own history and not three competing answers: the frame names one and that one
 * resolves. What may never resolve is anything foreign, or a name two traces
 * answer to — and neither is decided by how many traces there are.
 */
test('a named execution resolves out of a continued trial\'s own closed wakes', () => {
  const earlier = { ...traceFixture(), turn_id: 'earlier-execution' };
  const middle = { ...traceFixture(), turn_id: 'middle-execution' };
  assert.equal(executionClosed(activityFixture(), receiptFixture(), [earlier, middle, traceFixture()], 'agent:writer', executionId), executionId);
  // A name nothing answers to resolves to nothing, never to a neighbour by position.
  assert.equal(executionClosed(activityFixture(), receiptFixture(), [earlier, middle], 'agent:writer', executionId), undefined);
  // Another agent's execution among this trial's own is refused whatever the arity.
  assert.throws(() => executionClosed(activityFixture(), receiptFixture(), [{ ...earlier, agent_id: 'other' }, traceFixture()], 'agent:writer', executionId), /identity/);
  // And two traces answering to the named execution resolve to neither of them.
  assert.throws(() => executionClosed(activityFixture(), receiptFixture(), [earlier, traceFixture(), traceFixture()], 'agent:writer', executionId),
    new RegExp(AMBIGUOUS_NATIVE_EXECUTION, 'u'));
  // A still-running runtime outranks any of it: nothing resolves while it spends.
  assert.equal(executionClosed(activityFixture(true), receiptFixture(), [earlier, traceFixture()], 'agent:writer', executionId), undefined);
});

/**
 * Which execution answers for a delivery is the runtime's own statement, and it
 * has two forms because Daimon writes them at different moments: the receipt
 * carries the execution while the wake runs and keeps it on a completed
 * delivery, and the projection names the deliveries an admitted execution
 * covers — the only authority left once a deferral has cleared the receipt's.
 */
test('a delivery is bound to the execution the runtime names for it, not to a neighbour', () => {
  const receipt = receiptFixture();
  assert.equal(claimedExecution(receipt, activityFixture(), 'trial:wake', 'agent:writer'), executionId);
  // Cleared by the subject's deferral: the live projection still says whose it is.
  const deferred = { ...receipt, state: 'accepted' as const, deferred: true, execution_id: undefined };
  assert.equal(claimedExecution(deferred, activityFixture(true), 'trial:wake', 'agent:writer'), executionId);
  // An execution running for ANOTHER delivery of this trial is not this one's, and
  // that is the whole of the live defect: a continuation was handed the execution
  // the runtime had opened to revisit the trial's own deferred assignment.
  const elsewhere = { ...activityFixture(true), executions: [{ ...activityFixture(true).executions![0]!, delivery_ids: ['trial:task'] }] };
  assert.equal(claimedExecution(deferred, elsewhere, 'trial:answer', 'agent:writer'), undefined);
  assert.equal(claimedExecution({ ...deferred, agent_id: 'other' }, { ...activityFixture(), executions: [] }, 'trial:wake', 'agent:writer'), undefined);
  assert.equal(claimedExecution(deferred, { ...activityFixture(), executions: undefined }, 'trial:wake', 'agent:writer'), undefined);
});

/**
 * And when it names none, the question may only be asked of a delivery it has
 * already disposed of, on a runtime admitting nothing — and answered by what
 * closed inside this wake's own window.
 */
test('an undisposed delivery answers for nothing, and two unattributed executions refuse', () => {
  const history = new Set<string>(['earlier-execution']);
  const traces = [{ ...traceFixture(), turn_id: 'earlier-execution' }, traceFixture()];
  // Still queued: the runtime has said nothing about this delivery, and the trace
  // that just closed belongs to whatever the runtime was doing meanwhile.
  assert.equal(disposedWakeExecution({ ...receiptFixture(), state: 'accepted' }, traces, history), undefined);
  assert.equal(disposedWakeExecution(receiptFixture(), traces, history), executionId);
  assert.equal(disposedWakeExecution({ ...receiptFixture(), state: 'accepted', deferred: true }, traces, history), executionId);
  assert.equal(disposedWakeExecution(receiptFixture(), [traces[0]!], history), undefined);
  // Two executions closed inside one delivery's window and nothing says which is
  // its own: it fails closed under its own name rather than taking the first.
  assert.throws(() => disposedWakeExecution(receiptFixture(), [...traces, { ...traceFixture(), turn_id: 'another-execution' }], history),
    new RegExp(AMBIGUOUS_WAKE_EXECUTION, 'u'));
});

test('frame-wide validation precedes busy or missing selection and covers unnamed history', () => {
  const trace = traceFixture();
  const history = { ...trace, turn_id: 'earlier' };
  for (const active of [false, true]) {
    for (const traces of [[{ ...trace, status: 'failed' as const }, trace], [trace, { ...trace, status: 'failed' as const }],
      [history, history], [history, history, trace]]) {
      assert.throws(() => executionClosed(activityFixture(active), receiptFixture(), traces, 'agent:writer', executionId),
        new RegExp(AMBIGUOUS_NATIVE_EXECUTION, 'u'));
    }
    assert.throws(() => executionClosed(activityFixture(active), receiptFixture(), [{ ...history, agent_id: 'other' }],
      'agent:writer', executionId), /identity/);
    assert.throws(() => executionClosed(activityFixture(active), { ...receiptFixture(), execution_id: 'other' }, [],
      'agent:writer', executionId), /identity/);
  }
});

test('a declared-limit stop is read only from the failed execution\'s own sealed limit row, for any engine', () => {
  const failed = { ...traceFixture(), status: 'failed' as const, error: { message: 'engine broker turn failed (limit_exceeded; limit=timeout)' } };
  const row = (limit: string, wake = executionId, engine = 'grok') => ({ v: 'noopolis.daimon.turn-usage.v1', agent: 'agent:writer', wake, engine,
    input: 1, output: 1, cache_read: 0, total: 2, complete: false, limit_reason: limit }) as unknown as NativeUsage;
  for (const limit of ['tokens', 'requests', 'timeout'] as const) assert.equal(declaredLimitStop(failed, [row(limit)]), limit);
  // Engine-neutral: the sealed contract decides, never the engine name.
  assert.equal(declaredLimitStop(failed, [row('timeout', executionId, 'codex')]), 'timeout');
  // The broker's own prose without a sealed row, `none`, an unknown reason or another
  // execution's row is not this execution's declared-limit stop.
  assert.equal(declaredLimitStop(failed, []), undefined);
  assert.equal(declaredLimitStop(failed, [row('none')]), undefined);
  assert.equal(declaredLimitStop(failed, [row('secret')]), undefined);
  assert.equal(declaredLimitStop(failed, [row('timeout', 'other-execution')]), undefined);
  // Only a failed trace can have stopped on a limit.
  assert.equal(declaredLimitStop(traceFixture(), [row('timeout')]), undefined);
  assert.equal(declaredLimitStop(undefined, [row('timeout')]), undefined);
});
