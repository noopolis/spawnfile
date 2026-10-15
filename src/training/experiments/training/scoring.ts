import type { TrainingScoring } from '../../contracts/training-config.js';
import type { EvaluationResult } from '../../contracts/evaluation.js';
import type { TrialReport } from '../trials/index.js';

function atomicMeasurementFailed(check: EvaluationResult): boolean {
  return Boolean(check.atomicFailure) || check.atomicGrading?.status === 'error' || Boolean(check.atomicGrading?.failure) ||
    Boolean(check.children?.some(atomicMeasurementFailed));
}

/** A missing or interrupted measurement is not a cheap zero-quality observation. */
export function trialScore(
  report: Pick<TrialReport, 'id' | 'execution' | 'hostWork' | 'stop' | 'decisiveFailure' | 'status' | 'preDeferralStatus' | 'evaluation'>,
  scoring?: TrainingScoring,
): number {
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
  // Logical gates may mask errors; failed atomic measurements still have no behavioral score.
  const checks = [...Object.values(report.evaluation.checks ?? {}),
    ...report.evaluation.stages.flatMap(stage => [...stage.checks, stage.gate])];
  if (checks.some(atomicMeasurementFailed)) throw new Error(`Trial ${report.id} has unscorable atomic grading measurement`);
  // The trial owner combines every actual gate before adding the deferral witness.
  // Legacy captures have no such provenance and conservatively retain zero reward.
  const deferredReward = scoring?.deferred === 'stage-score' && deferred &&
    report.preDeferralStatus === 'pass' && !decisive;
  if (report.status === 'fail' && !deferredReward) return 0;
  const score = report.evaluation.stages.at(-1)?.score;
  if (score && score.missingWeight > 1e-9) throw new Error('Trial scoring coverage is incomplete');
  return score?.lower ?? (deferredReward ? 0 : 1);
}
