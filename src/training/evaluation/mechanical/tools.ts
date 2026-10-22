import type { CheckNode } from '../../contracts/dataset.js';
import type { EvaluationContext, EvaluationResult } from '../../contracts/evaluation.js';
import { capturedCalls, completeToolScope } from '../../capture/index.js';
import { result } from '../logic/index.js';

export async function evaluateTool(check: CheckNode, context: EvaluationContext): Promise<EvaluationResult> {
  const { snapshot } = context;
  const complete = completeToolScope(snapshot.closed, snapshot.coverage);
  const calls = capturedCalls(snapshot.events).filter(call => {
    if (call.tool !== check.tool) return false;
    if (check.phase === 'dispatch' && !call.dispatch) return false;
    if ((check.phase === 'completion' || check.outcome) && !call.completion) return false;
    if (check.outcome === 'succeeded') return call.success === true;
    if (check.outcome === 'failed') return call.success === false;
    return Boolean(call.dispatch || call.completion);
  });
  const count = calls.length;
  const evidence = calls.map(call => ({ kind: 'event' as const, id: (call.dispatch ?? call.completion)!.id }));
  if (check.eval === 'tool-called') return count > 0
    ? { ...result('pass', `Observed ${count} matching calls`), evidence, score: 1 }
    : result(complete ? 'fail' : 'unknown', 'No matching call in declared observation scope', snapshot.closed);
  if (check.eval !== 'tool-count') throw new Error(`Unknown tool evaluator ${check.eval}`);
  const low = typeof check.exactly === 'number' ? check.exactly : typeof check.at_least === 'number' ? check.at_least : 0;
  const high = typeof check.exactly === 'number' ? check.exactly : typeof check.at_most === 'number' ? check.at_most : Infinity;
  // Counts grow monotonically: an exceeded upper bound cannot be repaired.
  if (count > high) return { ...result('fail', `${count} calls exceed ${high}`), evidence, score: 0 };
  if (high === Infinity && count >= low) return { ...result('pass', `${count} calls meet ${low}`), evidence, score: 1 };
  if (!complete) return { ...result('unknown', `Observed ${count}; count scope is not complete`, snapshot.closed), evidence };
  return { ...result(count >= low ? 'pass' : 'fail', `${count} calls in [${low}, ${high}]`),
    evidence, score: count >= low ? 1 : 0 };
}
