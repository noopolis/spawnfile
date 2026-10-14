import type { EvaluationResult } from '../../contracts/evaluation.js';
import type { TrialReport } from '../trials/index.js';

function admissionFailed(check: EvaluationResult): boolean {
  return check.atomicGrading?.failure?.cause === 'spend-cap' || Boolean(check.children?.some(admissionFailed));
}

/** A missing or interrupted measurement is not a cheap zero-quality observation. */
export function trialScore(report: Pick<TrialReport, 'id' | 'execution' | 'hostWork' | 'stop' | 'decisiveFailure' | 'status' | 'evaluation'>): number {
  if (report.execution === 'failed') throw new Error(`Trial ${report.id} failed in infrastructure`);
  if (report.hostWork !== 'settled' || report.stop?.state !== 'acknowledged') throw new Error(`Trial ${report.id} has incomplete infrastructure cleanup`);
  const decisive = report.decisiveFailure?.status === 'fail' && report.decisiveFailure.finality === 'final' && report.status === 'fail';
  // A closed execution whose delivery stayed deferred is a behavioural outcome the
  // optimizer must see, not a broken machine — but only with the quiescence proof, and
  // never as a pass: an unanswered delivery is not completed training evidence.
  const deferred = report.execution === 'deferred' && report.stop?.quiescence === 'confirmed';
  if (report.execution !== 'completed' && !decisive && !deferred) throw new Error(`Trial ${report.id} has incomplete native execution`);
  if (report.status !== 'pass' && report.status !== 'fail') throw new Error(`Trial ${report.id} has unscorable ${report.status} evidence`);
  if (deferred && report.status !== 'fail') throw new Error(`Trial ${report.id} cannot pass on a deferred delivery`);
  // Logical gates can be decisive despite an errored sibling; admission still has no behavioral score.
  const checks = [...Object.values(report.evaluation.checks ?? {}),
    ...report.evaluation.stages.flatMap(stage => [...stage.checks, stage.gate])];
  if (checks.some(admissionFailed)) throw new Error(`Trial ${report.id} has unscorable grading admission: spend cap`);
  if (report.status === 'fail') return 0;
  const score = report.evaluation.stages.at(-1)?.score;
  if (score && score.missingWeight > 1e-9) throw new Error('Trial scoring coverage is incomplete');
  return score?.lower ?? 1;
}
