import { evaluateAtomicGrader } from './atomic-grader.js';
import type { CheckNode } from '../contracts/dataset.js';
import type { EvaluationContext, EvaluationResult } from '../contracts/evaluation.js';
import type { GraderBinding } from '../cases/index.js';
import { allQuestions, gradeOutput, type GateOutcome } from '../graders/index.js';
import { collectJudgeCalls, result } from './logic/index.js';
import { selectEvidence } from './selectors.js';

/** All provider construction belongs to the host; this evaluator only consumes injected routes. */
export async function evaluateGrader(check: CheckNode, context: EvaluationContext): Promise<EvaluationResult> {
  const runtime = context.graders?.[check.grader as string];
  if (!runtime) throw new Error(`Unresolved grader runtime ${String(check.grader)}`);
  if ('kind' in runtime && runtime.kind === 'atomic') return evaluateAtomicGrader(check, context, runtime);
  const legacy = runtime as import('../graders/index.js').GradingRuntime;
  const binding = check.grader_binding as GraderBinding | undefined;
  if (!binding || legacy.definitionDigest !== binding.definitionDigest || legacy.calibrationDigest !== binding.calibrationDigest) {
    throw new Error('Grader runtime identity does not match resolved grader/calibration files');
  }
  const selected = selectEvidence(check.input as string, context.snapshot);
  if (!selected.found) return { ...result('unknown', 'Graded artifact was not observed', context.snapshot.closed), evidence: selected.evidence };
  const bound: Record<string, unknown> = {};
  const evidence = [...selected.evidence];
  const selectors = (check.context ?? {}) as Record<string, string>;
  for (const name of Object.keys(selectors)) {
    if (!Object.hasOwn(legacy.grader.context, name)) throw new Error(`Unknown grader context ${name}`);
    const selection = selectEvidence(selectors[name]!, context.snapshot);
    if (selection.found) bound[name] = selection.value;
    evidence.push(...selection.evidence);
  }
  // Direct engine clients must not bypass the resolution guarantee; absent trial data
  // stays absent so instance expansion records missing coverage instead of empty evidence.
  const unbound = allQuestions(legacy.grader).flatMap(question => [...question.reads, ...(typeof question.when === 'object' ? [question.when.field] : [])])
    .filter(read => read.startsWith('context.') && !Object.hasOwn(selectors, read.slice(8)));
  if (unbound.length) return { ...result('unknown', `Unbound grader context: ${unbound.join(', ')}`, context.snapshot.closed), evidence };
  const children: EvaluationResult[] = [];
  const gateOutcomes: Record<string, GateOutcome> = {};
  const artifact = context.snapshot.artifacts[(check.input as string).slice(9).split('#')[0]!];
  for (const gate of binding.gates) {
    if (!context.evaluateCheck) throw new Error('Grader gates require the evaluation engine');
    const evaluated = await context.evaluateCheck(gate.check, artifact);
    children.push({ ...evaluated, id: gate.id });
    evidence.push(...evaluated.evidence);
    gateOutcomes[gate.id] = evaluated.status === 'skipped' ? 'unknown' : evaluated.status;
    if (evaluated.status === 'fail') break;
  }
  const graded = await gradeOutput({ ...legacy, output: selected.value, context: bound, gateOutcomes, signal: context.signal });
  const judgeCalls = collectJudgeCalls([...children, { ...result(graded.status, 'Grader'), judgeCalls: graded.judgeCalls }]);
  return { ...result(graded.status, `Grader ${legacy.grader.id}; coverage ${graded.coverage}`, context.snapshot.closed),
    score: graded.score, grading: graded, evidence, children, judgeCalls,
    usage: judgeCalls.flatMap(call => call.usage ? [call.usage] : []) };
}
