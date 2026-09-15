import { randomUUID } from 'node:crypto';
import { assertOriginalPolicy } from '../../candidates/index.js';
import { validateDatasetSplit } from '../../cases/index.js';
import type { ResolvedDataset } from '../../contracts/dataset.js';
import { TrainingCheckpoint, partitionTraining, freezeCriteria, trialScore, recoverMeasurement, recoverStoredReport } from '../training/index.js';
import { runStoredTrial, type TrialReport } from '../trials/index.js';
import type { ComparisonOptions, ComparisonReport } from './types.js';

/** Paired, frozen arms. No optimizer is constructed or invoked. */
export async function compareCandidates(options: ComparisonOptions): Promise<ComparisonReport> {
  assertOriginalPolicy(options.baseline, options.candidate);
  if (options.candidate.id === options.baseline.id || options.candidate.parentId !== options.baseline.id) throw new Error('Comparison requires one authored child of the baseline');
  if (!options.name.trim() || options.name.length > 120) throw new Error('Invalid authored candidate name');
  const partition = options.validation ? { train: options.train, validation: options.validation }
    : partitionTraining(options.train, options.validationGroups);
  validateDatasetSplit(partition.train, options.test, partition.validation);
  const phases = [['train', partition.train], ['validation', partition.validation], ['test', options.test]] as const;
  const required = 2 * phases.reduce((sum, [, dataset]) => sum + dataset.records.length, 0);
  if (!Number.isSafeInteger(options.maxTrials) || options.maxTrials < required || options.maxTrials > 10000) throw new Error('Comparison budget must cover both arms on every case');
  const criteria = new Map<ResolvedDataset, ComparisonOptions['native']['evaluation']>();
  for (const [phase, dataset] of phases) criteria.set(dataset, await freezeCriteria(dataset, options.native.evaluation,
    options.native.registry, `${phase}:${dataset.id}:${dataset.sourceDigest}:${dataset.sharedPlanDigest}`));
  const checkpoint = await TrainingCheckpoint.openComparison(options, phases.map(([, dataset]) => dataset));
  const trials = [...checkpoint?.reports ?? []], rescores = [...checkpoint?.rescores ?? []];
  for (const report of trials) await options.onProgress?.({ type: 'trial.restored', payload: report });
  for (const report of rescores) await options.onProgress?.({ type: 'trial.rescore.restored', payload: report });
  const partitions = { train: partition.train.records.map(r => r.id), validation: partition.validation.records.map(r => r.id), test: options.test.records.map(r => r.id) };
  await options.onProgress?.({ type: 'comparison.started', payload: { ...partitions, baselineId: options.baseline.id,
    candidateId: options.candidate.id, name: options.name, budget: { maxTrials: required, maxProposals: 0 } } });
  const measured = (report: TrialReport) => rescores.findLast(row => row.runId === report.id) ?? report;
  const pairs: ComparisonReport['pairs'] = [];
  for (const [phase, dataset] of phases) {
    if (phase === 'test') await options.onProgress?.({ type: 'comparison.frozen', payload: { baselineId: options.baseline.id, candidateId: options.candidate.id } });
    for (const record of dataset.records) {
      const pair: TrialReport[] = [];
      for (const candidate of [options.baseline, options.candidate]) {
        options.signal?.throwIfAborted();
        const key = `comparison:${phase}:${candidate.id}:${record.id}`;
        const entry = await checkpoint?.begin(key);
        if (entry?.restored) {
          const report = await recoverStoredReport(options, entry.id, phase, candidate.id, entry.report);
          if (!entry.report) { await checkpoint!.complete(key, report); entry.report = report; trials.push(report); }
        }
        let report = entry?.report;
        if (report) {
          const rescore = await recoverMeasurement({ options, dataset, report, previous: entry?.rescores?.at(-1),
            evaluation: criteria.get(dataset)!, signal: options.signal, pendingRescoreId: entry?.pendingRescoreId,
            reserve: () => checkpoint!.reserveRecovery(options.checkpoint?.maxRecoveryAttempts ?? 2, key) });
          if (rescore && rescore !== entry?.rescores?.at(-1)) {
            await checkpoint!.rescore(key, rescore); rescores.push(rescore);
            await options.onProgress?.({ type: 'trial.rescored', payload: rescore });
          }
          await options.onProgress?.({ type: 'trial.reused', payload: { id: report.id, caseId: record.id, phase, candidateId: candidate.id } });
        } else {
          const id = entry?.id ?? randomUUID();
          await options.onProgress?.({ type: 'trial.queued', payload: { caseId: record.id, phase, candidateId: candidate.id } });
          report = await runStoredTrial({ ...options.native, id, phase, record: structuredClone(record), candidate,
            datasetId: dataset.id, datasetDigest: dataset.sourceDigest, planDigest: dataset.sharedPlanDigest,
            signal: options.signal, evaluation: criteria.get(dataset)!,
            protectedPaths: [...options.native.protectedPaths ?? [], ...options.checkpoint ? [options.checkpoint.directory] : []],
            observeEvent: async event => {
              await options.native.observeEvent?.(event);
              await options.onProgress?.({ type: 'trial.progress', payload: { trialId: id, caseId: record.id, phase, candidateId: candidate.id, event } });
            } });
          await checkpoint?.complete(key, report); trials.push(report);
          await options.onProgress?.({ type: 'trial.finished', payload: report });
        }
        trialScore(measured(report)); // Incomplete execution or measurement is never a zero-quality result.
        pair.push(report);
      }
      const [baseline, candidate] = pair as [TrialReport, TrialReport];
      const baselineScore = trialScore(measured(baseline)), candidateScore = trialScore(measured(candidate));
      pairs.push({ caseId: record.id, phase, baselineTrialId: baseline.id, candidateTrialId: candidate.id,
        baselineScore, candidateScore, delta: candidateScore - baselineScore });
    }
  }
  const report: ComparisonReport = { schema: 'paideia.comparison.v1', id: options.id, baseline: options.baseline,
    candidate: options.candidate, name: options.name, partitions, trials, pairs,
    ...(rescores.length ? { rescores } : {}), provenance: { mode: 'authored-comparison', optimizerCalls: 0 } };
  await options.onProgress?.({ type: 'comparison.completed', payload: report });
  return report;
}
