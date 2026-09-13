import type { CheckNode } from '../../contracts/dataset.js';
import type { EvaluationContext, EvaluationResult } from '../../contracts/evaluation.js';
import { capturedCalls, completeToolScope, happensBefore, type CapturedCall } from '../../capture/index.js';
import { result } from '../logic/index.js';
import { bindingValue, predicate } from './predicates.js';

interface Step { tool: string; where?: { cel: string }; bind?: Record<string, string> }

export async function evaluateSequence(check: CheckNode, context: EvaluationContext): Promise<EvaluationResult> {
  const { snapshot } = context;
  const steps = check.steps as Step[];
  const ending = check.ending_at as { artifact: string; event: string } | undefined;
  const artifact = ending ? snapshot.artifacts[ending.artifact] : undefined;
  const accepted = artifact?.acceptedCallId;
  const evidence = artifact ? [{ kind: 'artifact' as const, id: artifact.checkpointId, digest: artifact.digest }] : [];
  if (ending && !accepted) return { ...result('unknown', 'Accepted artifact has no authentic call lineage', snapshot.closed), evidence };
  const calls = capturedCalls(snapshot.events).filter(call => call.success === true && call.dispatch && call.completion)
    .sort((a, b) => (a.dispatch!.source < b.dispatch!.source ? -1 : a.dispatch!.source > b.dispatch!.source ? 1 : 0) || a.dispatch!.seq - b.dispatch!.seq);
  const matches: CapturedCall[][] = [];
  let uncertain = false;
  let visited = 0;
  function search(index: number, prior: CapturedCall[], bindings: Record<string, unknown>): void {
    if (++visited > 20_000) throw new Error('Sequence matching budget exceeded');
    const step = steps[index]!;
    for (const call of calls) {
      if (call.tool !== step.tool || prior.some(item => item.id === call.id)) continue;
      if (index === steps.length - 1 && accepted && call.id !== accepted) continue;
      const previous = prior.at(-1);
      if (previous) {
        const order = happensBefore(previous.completion!, call.dispatch!, snapshot.events, snapshot.coverage);
        if (order === undefined) uncertain = true;
        if (order !== true) continue;
      }
      const values = { call, context: snapshot.context, bindings };
      const pass = step.where ? predicate(step.where.cel, values) : true;
      if (pass === undefined) uncertain = true;
      if (pass !== true) continue;
      const nextBindings = { ...bindings };
      let missing = false;
      for (const [name, selector] of Object.entries(step.bind ?? {})) {
        const value = bindingValue(selector, values);
        if (value === undefined) { uncertain = true; missing = true; break; }
        nextBindings[name] = value;
      }
      if (missing) continue;
      const tuple = [...prior, call];
      if (index + 1 === steps.length) matches.push(tuple);
      else search(index + 1, tuple, nextBindings);
    }
  }
  if (!steps.length) throw new Error('Sequence must have steps');
  search(0, [], {});
  if (matches.length) {
    // Every matching tuple is retained; the first witness is deterministic by native source/sequence.
    return { ...result('pass', `${matches.length} valid ordered tuple(s)`, !ending || snapshot.closed), score: 1,
      evidence: [...evidence, ...matches.flatMap(tuple => tuple.flatMap(call => [
        { kind: 'event' as const, id: call.dispatch!.id }, { kind: 'event' as const, id: call.completion!.id },
      ]))] };
  }
  const complete = completeToolScope(snapshot.closed, snapshot.coverage);
  return { ...result(complete && !uncertain ? 'fail' : 'unknown', uncertain
    ? 'Call ordering or predicate evidence is incomplete' : 'No successful bound sequence', snapshot.closed), evidence };
}
