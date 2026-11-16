import type { TrainingScoring } from '../../contracts/training-config.js';
import type { EvaluationResult, PlanEvaluation } from '../../contracts/evaluation.js';

export const DEFAULT_GATE_PENALTY = 0.5;
export const DEFAULT_MISSING_OUTPUT = 0.05;

/** One failed gate on a trial's ladder, lowest first: the check, its factor and the questions behind it. */
export interface TrialRung { check: string; factor: number; absent?: true; questions?: { id: string; factor: number; count?: number }[] }

export interface TrialLadder {
  /** Every gate passed: the strict verdict a candidate needs to ship. */
  accepted: boolean;
  /** Nothing was filed: the graded artifact is missing. */
  absent: boolean;
  rungs: TrialRung[];
  /** The product of every rung's factor. */
  factor: number;
}

const round = (value: number) => Math.round(value * 10_000) / 10_000;

/** The checks of a stage its gate failed on: leaves of the gate tree that name a stage check and did not pass. */
function failedGateChecks(stage: PlanEvaluation['stages'][number]): EvaluationResult[] {
  const byId = new Map(stage.checks.flatMap(check => check.id ? [[check.id, check] as const] : []));
  const found = new Map<string, EvaluationResult>();
  const visit = (node: EvaluationResult) => {
    if (node.id && byId.has(node.id)) { if (byId.get(node.id)!.status === 'fail') found.set(node.id, byId.get(node.id)!); return; }
    node.children?.forEach(visit);
  };
  visit(stage.gate);
  return [...found.values()];
}

/**
 * The rungs a trial failed, in the order its stages declare them. A laddered questionnaire brings its own
 * factor (the product over its failed gate questions); any other failed gate check costs `gate_penalty`.
 * Missing output is the bottom rung: the agent filed nothing to grade.
 */
export function trialLadder(evaluation: PlanEvaluation, status: string, scoring?: TrainingScoring): TrialLadder {
  const penalty = scoring?.gate_penalty ?? DEFAULT_GATE_PENALTY;
  const rungs: TrialRung[] = [];
  for (const stage of evaluation.stages) {
    if (stage.gate.status !== 'fail') continue;
    for (const check of failedGateChecks(stage)) {
      if (check.absent) { rungs.push({ check: check.id!, factor: 0, absent: true }); continue; }
      const questionnaire = check.questionnaire;
      if (questionnaire?.factor !== undefined && questionnaire.factor !== null) {
        rungs.push({ check: check.id!, factor: questionnaire.factor, questions: questionnaire.rungs.map(rung => ({ ...rung })) });
      } else rungs.push({ check: check.id!, factor: penalty });
    }
  }
  const absent = rungs.some(rung => rung.absent);
  // A failed outcome with no failed gate check (a deferred delivery, an exhausted limit) is one plain rung.
  if (status === 'fail' && rungs.length === 0) rungs.push({ check: 'trial-outcome', factor: penalty });
  rungs.sort((left, right) => Number(Boolean(right.absent)) - Number(Boolean(left.absent)));
  return { accepted: status === 'pass', absent, rungs, factor: round(rungs.reduce((product, rung) => product * rung.factor, 1)) };
}

/**
 * The graded search score of a measured trial: its stage score times every failed rung's factor, and a small
 * fixed floor when it filed nothing. The trial records cannot yet tell reading, gathering and drafting apart
 * without runtime-specific transcript parsing, so every trial that filed nothing gets the same floor.
 */
export function ladderScore(evaluation: PlanEvaluation, status: string, stageScore: number, scoring?: TrainingScoring): number {
  const floor = scoring?.missing_output ?? DEFAULT_MISSING_OUTPUT;
  const ladder = trialLadder(evaluation, status, scoring);
  if (ladder.absent) return floor;
  return round(Math.max(floor, stageScore * ladder.factor));
}

/** The scoring policy when it departs from the defaults; it then binds checkpoint identity and is kept on the report. */
export function declaredScoring(scoring?: TrainingScoring): TrainingScoring | undefined {
  return scoring?.deferred === 'stage-score' || scoring?.search === 'ladder' ? { ...scoring } : undefined;
}
