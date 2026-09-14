import { isDeepStrictEqual } from 'node:util';
import type { EvaluationResult } from '../../contracts/evaluation.js';
import type { ResolvedDataset } from '../../contracts/dataset.js';
import { capturedTrial, rescoreStoredTrial, type RescoreReport } from '../replay/index.js';
import type { StoredTrialOptions, TrialReport } from '../trials/index.js';
import type { TrainingOptions } from './training.js';

const retryable = new Set(['quota', 'transport', 'unavailable', 'timeout', 'cancelled']);
function transientJudgeFailure(check: EvaluationResult): boolean {
  if (check.children?.length) return check.children.filter(child => child.status === 'error').every(transientJudgeFailure);
  const last = check.judgeCalls?.at(-1);
  return last?.outcome === 'generation-error' && retryable.has(last.failureKind ?? 'unknown');
}

/** Only a completed native capture with failed final measurement is eligible. */
export async function recoverMeasurement(input: {
  options: TrainingOptions;
  dataset: ResolvedDataset;
  report: TrialReport;
  previous?: RescoreReport;
  evaluation: StoredTrialOptions['evaluation'];
  signal?: AbortSignal;
  pendingRescoreId?: string;
  reserve(): Promise<string>;
}): Promise<RescoreReport | undefined> {
  const { report, options } = input;
  let previous = input.previous;
  if (input.pendingRescoreId && input.pendingRescoreId !== previous?.id) {
    const replay = await options.native.store.readReplay(report.id, { audience: 'evaluator',
      phase: report.phase === 'train' ? 'training' : report.phase, frozenCandidateIds: [options.baseline.id, report.candidateId] });
    const settled = replay.evaluations.find(entry => entry.id === input.pendingRescoreId)?.report;
    if (settled) previous = settled as RescoreReport;
  }
  if (previous?.status === 'pass' || previous?.status === 'fail') return previous;
  if (report.status === 'pass' || report.status === 'fail') return undefined;
  if (report.execution !== 'completed' || report.hostWork !== 'settled' || report.stop?.state !== 'acknowledged') {
    throw new Error(`Cannot resume incomplete native capture ${report.id}; no successful execution or cleanup may be assumed`);
  }
  if (report.status !== 'error' || report.evaluation.status !== 'error') {
    throw new Error(`Cannot resume ${report.status} measurement; missing evidence is not an inference retry`);
  }
  const errors = Object.values((previous ?? report).evaluation.checks).filter(check => check.status === 'error');
  if (!errors.length || !errors.every(transientJudgeFailure)) throw new Error('Measurement recovery requires classified transient judge failures');
  const id = await input.reserve();
  return rescoreStoredTrial({ store: options.native.store, runId: report.id,
    access: { audience: 'evaluator', phase: report.phase === 'train' ? 'training' : report.phase,
      ...(report.phase === 'test' ? { frozenCandidateIds: [options.baseline.id, report.candidateId] } : {}) },
    id, dataset: input.dataset, registry: options.native.registry,
    evaluation: input.evaluation, signal: input.signal });
}

/** Restore only an integrity-checked terminal report; pending work is never presumed stopped. */
export async function recoverStoredReport(options: TrainingOptions, id: string, phase: TrialReport['phase'], candidateId: string,
  expected?: TrialReport): Promise<TrialReport> {
  const replay = await options.native.store.readReplay(id, { audience: 'evaluator', phase: phase === 'train' ? 'training' : phase,
    ...(phase === 'test' ? { frozenCandidateIds: [options.baseline.id, candidateId] } : {}) });
  const { report } = capturedTrial(replay);
  if (report.candidateId !== candidateId || report.phase !== phase || report.hostWork !== 'settled'
      || report.stop?.state !== 'acknowledged' || report.stop.quiescence !== 'confirmed') {
    throw new Error(`Pending native trial ${id} lacks verified terminal execution and shutdown; recovery is blocked`);
  }
  if (expected && !isDeepStrictEqual(report, JSON.parse(JSON.stringify(expected)))) throw new Error('Cached native report differs from immutable trial evidence');
  return report;
}
