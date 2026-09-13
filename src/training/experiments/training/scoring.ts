import type { TrialReport } from '../trials/index.js';

/** A missing or interrupted measurement is not a cheap zero-quality observation. */
export function trialScore(report: TrialReport): number {
  if (report.execution === 'failed') throw new Error(`Trial ${report.id} failed in infrastructure`);
  if (report.hostWork !== 'settled' || report.stop?.state !== 'acknowledged') throw new Error(`Trial ${report.id} has incomplete infrastructure cleanup`);
  const decisive = report.decisiveFailure?.status === 'fail' && report.decisiveFailure.finality === 'final' && report.status === 'fail';
  if (report.execution !== 'completed' && !decisive) throw new Error(`Trial ${report.id} has incomplete native execution`);
  if (report.status !== 'pass' && report.status !== 'fail') throw new Error(`Trial ${report.id} has unscorable ${report.status} evidence`);
  if (report.status === 'fail') return 0;
  const score = report.evaluation.stages.at(-1)?.score;
  if (score && score.missingWeight > 1e-9) throw new Error('Trial scoring coverage is incomplete');
  return score?.lower ?? 1;
}
