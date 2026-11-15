import type { CheckFeedbackLevel, CheckNode, ResolvedRecord } from '../../contracts/dataset.js';

export type Levels = ReadonlyMap<string, CheckFeedbackLevel>;

/** The declared `feedback` level of every identified check of a record; an undeclared check is `full`. */
export function feedbackLevels(record: ResolvedRecord): Levels {
  const levels = new Map<string, CheckFeedbackLevel>();
  const visit = (node: CheckNode) => {
    if (node.id && node.feedback) levels.set(node.id, node.feedback);
    [...node.all ?? [], ...node.any ?? [], ...node.not ? [node.not] : []].forEach(visit);
  };
  for (const stage of record.effectiveStages) stage.checks.forEach(visit);
  record.live.checks.forEach(visit);
  return levels;
}

/** Declared criteria as the optimizer may read them: a `status` check keeps its id and evaluator, a `none` check is absent. */
export function criteriaFeedback(stages: ResolvedRecord['effectiveStages']): unknown {
  const visit = (node: CheckNode): CheckNode[] => {
    if (node.feedback === 'none') return [];
    if (node.feedback === 'status') return [{ ...(node.id ? { id: node.id } : {}), eval: node.eval, feedback: 'status' }];
    return [{ ...node, ...(node.all ? { all: node.all.flatMap(visit) } : {}), ...(node.any ? { any: node.any.flatMap(visit) } : {}) }];
  };
  return stages.map(stage => ({ ...stage, checks: stage.checks.flatMap(visit) }));
}
