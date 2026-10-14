import type { CheckNode } from '../contracts/dataset.js';
import type { EvaluationContext, EvaluationResult } from '../contracts/evaluation.js';
import type { GraderBinding } from '../cases/index.js';
import { gradeAtomic, type AtomicRuntime } from '../graders/atomic/index.js';
import { collectJudgeCalls, result } from './logic/index.js';
import { selectEvidence } from './selectors.js';

/** Bind only host-captured accepted artifacts; final chat output is never a fallback. */
export async function evaluateAtomicGrader(check: CheckNode, context: EvaluationContext, runtime: AtomicRuntime): Promise<EvaluationResult> {
  const binding = check.grader_binding as GraderBinding | undefined;
  if (binding?.kind !== 'atomic' || binding.definitionDigest !== runtime.definitionDigest || binding.templatesDigest !== runtime.templatesDigest) {
    throw new Error('Atomic grader runtime identity does not match resolved files');
  }
  const artifact = context.snapshot.artifacts[(check.input as string).slice(9).split('#')[0]!];
  const selection = selectEvidence(check.input as string, context.snapshot);
  if (!artifact?.acceptedCallId || !selection.found) return result('unknown', 'Accepted graded artifact was not observed', context.snapshot.closed);
  const selectors = (check.context ?? {}) as Record<string, string>;
  const bound: Record<string, unknown> = {};
  const evidence = [...selection.evidence];
  for (const name of Object.keys(selectors)) {
    if (!Object.hasOwn(runtime.templates.context, name)) throw new Error(`Unknown grader context ${name}`);
    const selected = selectEvidence(selectors[name]!, context.snapshot);
    if (selected.found) bound[name] = selected.value;
    evidence.push(...selected.evidence);
  }
  // Missing trial context prevents extraction from manufacturing absent evidence.
  if (Object.keys(runtime.templates.context).some(name => !Object.hasOwn(bound, name))) {
    return { ...result(runtime.grader.missing, 'Atomic grader context was not observed', context.snapshot.closed), score: 0, evidence };
  }
  const children: EvaluationResult[] = [];
  let gateUnknown = false;
  for (const gate of binding.gates) {
    if (!context.evaluateCheck) throw new Error('Grader gates require the evaluation engine');
    const evaluated = await context.evaluateCheck(gate.check, artifact);
    children.push({ ...evaluated, id: gate.id }); evidence.push(...evaluated.evidence);
    if (evaluated.status === 'fail' || evaluated.status === 'error') {
      return { ...result(evaluated.status, 'Atomic grader acceptance gate failed', context.snapshot.closed), score: 0,
        evidence, children, judgeCalls: collectJudgeCalls(children) };
    }
    if (evaluated.status !== 'pass') gateUnknown = true;
  }
  const graded = await gradeAtomic(runtime, { output: selection.value, context: bound }, context.signal);
  const judgeCalls = collectJudgeCalls([...children, { ...result(graded.status, 'Atomic grader'), judgeCalls: graded.judgeCalls }]);
  return { ...result(graded.status === 'error' ? 'error' : gateUnknown ? 'unknown' : graded.status,
    graded.failure ? `Atomic grader admission failed: ${graded.failure.reason}` : `Atomic grader ${runtime.grader.id}; coverage ${graded.coverage}`, context.snapshot.closed),
    ...(graded.score === null ? {} : { score: graded.score }), atomicGrading: graded, evidence, children, judgeCalls,
    usage: judgeCalls.flatMap(call => call.usage ? [call.usage] : []) };
}
