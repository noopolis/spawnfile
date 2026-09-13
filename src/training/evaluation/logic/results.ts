import type { EvaluationResult, JudgeCall, Verdict, WeightedScore } from '../../contracts/evaluation.js';

export function result(status: Verdict, reason: string, final = true): EvaluationResult {
  return { status, finality: final ? 'final' : 'provisional', reason, evidence: [] };
}

export function negate(value: EvaluationResult): EvaluationResult {
  return { ...value, status: value.status === 'pass' ? 'fail' : value.status === 'fail' ? 'pass' : value.status,
    reason: `not: ${value.reason}`, children: [value],
    ...(value.score === undefined ? {} : { score: 1 - value.score }) };
}

export function collectJudgeCalls(results: readonly EvaluationResult[]): JudgeCall[] {
  const calls = new Map<string, JudgeCall>();
  for (const value of results) {
    for (const call of value.judgeCalls ?? []) if (!calls.has(call.id)) calls.set(call.id, call);
  }
  return [...calls.values()];
}

export function combine(operation: 'all' | 'any', children: EvaluationResult[]): EvaluationResult {
  if (children.length === 0) throw new Error('A logical composition cannot be empty');
  const decisive: Verdict = operation === 'all' ? 'fail' : 'pass';
  const unanimous: Verdict = operation === 'all' ? 'pass' : 'fail';
  const witnesses = children.filter(child => child.status === decisive);
  const status = witnesses.length ? decisive
    : children.every(child => child.status === unanimous) ? unanimous
    : children.some(child => child.status === 'error') ? 'error'
    : children.some(child => child.status === 'unknown') ? 'unknown' : 'skipped';
  const final = witnesses.length ? witnesses.some(child => child.finality === 'final')
    : children.every(child => child.finality === 'final');
  const judgeCalls = collectJudgeCalls(children);
  return { ...result(status, `${operation}: ${children.map(child => child.status).join(', ')}`, final),
    children, evidence: children.flatMap(child => child.evidence), ...(judgeCalls.length ? { judgeCalls } : {}) };
}

export function weightedScore(weights: Readonly<Record<string, number>>,
  checks: Readonly<Record<string, EvaluationResult>>): WeightedScore {
  const entries = Object.entries(weights);
  if (entries.length === 0 || entries.some(([, weight]) => !Number.isFinite(weight) || weight < 0) ||
      Math.abs(entries.reduce((sum, [, weight]) => sum + weight, 0) - 1) > 1e-9) {
    throw new Error('Score weights must be finite, nonnegative and sum to one');
  }
  let lower = 0;
  let assessedWeight = 0;
  for (const [id, weight] of entries) {
    const check = checks[id];
    if (!check || (check.status !== 'pass' && check.status !== 'fail')) continue;
    const score = check.score ?? (check.status === 'pass' ? 1 : 0);
    if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error('Invalid evaluator score');
    lower += weight * score;
    assessedWeight += weight;
  }
  const missingWeight = Math.max(0, 1 - assessedWeight);
  const finality = entries.every(([id, weight]) => weight === 0 || checks[id]?.finality === 'final')
    ? 'final' : 'provisional';
  return { lower, upper: lower + missingWeight, assessedWeight, missingWeight, finality };
}

export function checkThreshold(score: WeightedScore | undefined, minimum: number): EvaluationResult {
  if (!Number.isFinite(minimum) || minimum < 0 || minimum > 1) throw new Error('Invalid score threshold');
  if (!score || score.missingWeight > 1e-9) return result('unknown', 'Scoring coverage is incomplete', score?.finality === 'final');
  return { ...result(score.lower >= minimum ? 'pass' : 'fail', `Score ${score.lower}; minimum ${minimum}`, score.finality === 'final'),
    score: score.lower };
}
