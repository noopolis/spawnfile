import type { AtomicGrader } from './format.js';
import type { AtomicCheckScore } from './types.js';

/** Fixed dimension budgets: extra easy checks never enlarge a denominator. */
export function aggregateAtomic(grader: AtomicGrader, checks: AtomicCheckScore[]) {
  const policy = grader.aggregation;
  const criticalGate = checks.length > 0 && checks.filter(check => check.severity === 'critical')
    .every(check => check.probability !== null && check.probability >= policy.critical_pass_at) ? 1 : 0;
  const obligations = new Map<string, number>();
  const defects = new Map<string, Map<string, number>>();
  for (const check of checks) {
    const probability = check.probability ?? 0;
    if (policy.obligation_kinds.includes(check.kind)) {
      obligations.set(check.occurrence, Math.min(obligations.get(check.occurrence) ?? 1, probability));
    }
    // Correlated templates of the same dimension and source occurrence incur the strongest penalty once.
    const dimension = defects.get(check.dimension) ?? new Map<string, number>();
    dimension.set(check.occurrence, Math.max(dimension.get(check.occurrence) ?? 0, policy.penalties[check.severity] * (1 - probability)));
    defects.set(check.dimension, dimension);
  }
  const obligationCoverage = obligations.size ? [...obligations.values()].reduce((a, b) => a + b, 0) / obligations.size : 0;
  let weighted = 0, weights = 0;
  for (const [dimension, { weight, budget }] of Object.entries(policy.dimensions)) {
    const penalty = [...(defects.get(dimension)?.values() ?? [])].reduce((sum, value) => sum + value, 0);
    weighted += weight * (1 - Math.min(1, penalty / budget)); weights += weight;
  }
  const quality = weighted / weights;
  const coverage = checks.length ? checks.filter(check => check.probability !== null).length / checks.length : 0;
  // `coverage-times-quality` keeps critical failures as penalties so optimizers can rank failing candidates; pass still needs the gate.
  const gate = policy.method === 'gates-times-coverage-times-quality' ? criticalGate : 1;
  return { criticalGate, obligationCoverage, quality, coverage, score: gate * obligationCoverage * quality };
}
