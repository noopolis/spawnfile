import type { Grader } from './format/index.js';
import type { QuestionInstance } from './instances.js';

export type InstanceOutcome = ({ pGood: number } | { status: 'missing' | 'not-applicable' }) & { escalated?: boolean };
export type GateOutcome = 'pass' | 'fail' | 'unknown' | 'error';
export interface QuestionScore {
  id: string;
  score: number;
  instances: number;
  not_applicable: number;
  escalated: number;
  missing: number;
}
export interface GraderResult {
  status: 'pass' | 'fail' | 'unknown';
  score: number;
  coverage: number;
  gates: { id: string; status: GateOutcome }[];
  questions: QuestionScore[];
}

function probability(outcome: InstanceOutcome | undefined): number | undefined {
  if (!outcome || !('pGood' in outcome)) return undefined;
  return Number.isFinite(outcome.pGood) && outcome.pGood >= 0 && outcome.pGood <= 1 ? outcome.pGood : undefined;
}

function effectiveOutcome(instance: QuestionInstance, outcomes: Record<string, InstanceOutcome>,
  instanceByKey: Map<string, QuestionInstance>): InstanceOutcome {
  if (instance.state === 'missing') return { status: 'missing' };
  if (instance.state === 'not-applicable') return { status: 'not-applicable' };
  if (instance.dependsOn) {
    const dependency = instanceByKey.get(instance.dependsOn);
    const applicability = outcomes[instance.dependsOn];
    if (!dependency || dependency.state !== 'ready' || probability(applicability) === undefined) return { status: 'missing' };
    if (probability(applicability)! < 0.5) return { status: 'not-applicable', escalated: applicability?.escalated };
  }
  return outcomes[instance.key] ?? { status: 'missing' };
}

function questionScore(id: string, notApplicable: number, instances: QuestionInstance[],
  outcomes: Record<string, InstanceOutcome>, instanceByKey: Map<string, QuestionInstance>): QuestionScore {
  const relevant = instances.filter(instance => instance.questionId === id);
  let sum = 0;
  let missing = 0;
  let excluded = 0;
  let escalated = 0;
  for (const instance of relevant) {
    const outcome = effectiveOutcome(instance, outcomes, instanceByKey);
    if (outcome.escalated || (instance.dependsOn && outcomes[instance.dependsOn]?.escalated)) escalated++;
    if ('status' in outcome && outcome.status === 'not-applicable') excluded++;
    else {
      const value = probability(outcome);
      if (value === undefined) missing++;
      else sum += value;
    }
  }
  // A caller cannot turn an omitted expansion or a zero-unit level into applicability evidence.
  if (!relevant.length) missing = 1;
  const count = Math.max(1, relevant.length);
  const applicable = count - excluded;
  return { id, score: applicable ? sum / applicable : notApplicable,
    instances: count, not_applicable: excluded, escalated, missing };
}

/** Coverage is the observed fraction of declared question units, including known N/A units. */
export function aggregateGrader(grader: Grader, instances: QuestionInstance[],
  outcomes: Record<string, InstanceOutcome>, gateOutcomes: Record<string, GateOutcome> = {}): GraderResult {
  const byKey = new Map(instances.map(instance => [instance.key, instance]));
  const questions = grader.questions.map(question => questionScore(
    question.id, question.not_applicable, instances, outcomes, byKey));
  const gates = grader.gates.map(gate => {
    if ('check' in gate) return { id: gate.id, status: gateOutcomes[gate.id] ?? 'unknown' };
    const result = questionScore(gate.id, gate.not_applicable, instances, outcomes, byKey);
    return { id: gate.id, status: result.missing ? 'unknown' as const : result.score >= 0.5 ? 'pass' as const : 'fail' as const };
  });
  const totalWeight = grader.questions.reduce((sum, question) => sum + question.weight, 0);
  const weightedScore = grader.questions.reduce((sum, question, index) => sum + question.weight * questions[index]!.score, 0);
  const units = questions.reduce((sum, question) => sum + question.instances, 0);
  const missing = questions.reduce((sum, question) => sum + question.missing, 0);
  const coverage = units ? (units - missing) / units : 0;
  const failedGate = gates.some(gate => gate.status === 'fail');
  const unknownGate = gates.some(gate => gate.status === 'unknown' || gate.status === 'error');
  const score = failedGate ? 0 : weightedScore / totalWeight;
  const status = failedGate ? 'fail' : unknownGate || coverage < 1 ? 'unknown'
    : score >= (grader.score.pass_at ?? 0) ? 'pass' : 'fail';
  return { status, score, coverage, gates, questions };
}
