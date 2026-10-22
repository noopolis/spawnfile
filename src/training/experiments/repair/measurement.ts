import { verifyCapturedRecord } from './record.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CheckNode, Stage } from '../../contracts/dataset.js';
import type { EvaluationResult } from '../../contracts/evaluation.js';
import { combine, evaluatePlan, result, validateMeasurementRepair } from '../../evaluation/index.js';
import { freezeCriteria } from '../training/index.js';
import type { recoverMeasurement } from '../training/index.js';
import { capturedTrial, type RescoreReport } from '../replay/index.js';

type RecoveryInput = Parameters<typeof recoverMeasurement>[0];
export interface RepairedMeasurement extends RescoreReport {
  repair: { mode: 'errors-only'; receiptDigest: string; errorPaths: string[]; retainedCallIds: string[] };
}

function failedLeaves(stages: readonly Stage[], measurement: RescoreReport['evaluation']): string[] {
  const paths: string[] = [];
  const visit = (node: CheckNode, original: EvaluationResult, path: string) => {
    if (original.status === 'pass' || original.status === 'fail') return;
    if (node.eval && original.status === 'error') { paths.push(path); return; }
    const operation = node.all ? 'all' : node.any ? 'any' : 'not';
    (node.all ?? node.any ?? (node.not ? [node.not] : [])).forEach((child, index) => {
      const prior = original.children?.[index];
      if (!prior) throw new Error('Original measurement tree is incomplete');
      visit(child, prior, `${path}/${operation}${operation === 'not' ? '' : `/${index}`}`);
    });
  };
  stages.forEach((stage, index) => stage.checks.forEach((check, position) => {
    const prior = measurement.stages[index]?.checks[position];
    if (!prior) throw new Error('Original measurement stage is incomplete');
    visit(check, prior, `/stages/${index}/checks/${position}`);
  }));
  return paths;
}

/** Explicit repair fork; never reclassifies a historical protocol failure as transient. */
export async function repairMeasurement(input: RecoveryInput, receiptDigest: string): Promise<RescoreReport | undefined> {
  const { report, options } = input;
  if (report.phase === 'test') throw new Error('Measurement repair does not migrate sealed-test state');
  const access = { audience: 'evaluator' as const, phase: report.phase === 'train' ? 'training' as const : 'validation' as const };
  const replay = await options.native.store.readReplay(report.id, access);
  const { report: original, source } = capturedTrial(replay);
  if (!isDeepStrictEqual(original, report) || original.execution !== 'completed' || original.hostWork !== 'settled' ||
      original.stop?.state !== 'acknowledged' || original.stop.quiescence !== 'confirmed') throw new Error('Repair requires verified closed native evidence');
  let previous = input.previous;
  if (input.pendingRescoreId && input.pendingRescoreId !== previous?.id) {
    const settled = replay.evaluations.find(entry => entry.id === input.pendingRescoreId)?.report;
    if (settled) previous = settled as RescoreReport;
  }
  if (previous?.status === 'pass' || previous?.status === 'fail') return previous;
  if (report.status === 'pass' || report.status === 'fail') return undefined;
  const record = input.dataset.records.find(item => item.id === report.recordId);
  if (!record || record.turns?.some(turn => turn.checks?.length)) throw new Error('Measurement repair supports captured final plans only');
  const capturedRecord = await verifyCapturedRecord(options.native.store, report.id, access, record);
  if (previous && !isDeepStrictEqual(previous.criteria.stages, capturedRecord.effectiveStages)) throw new Error('Prior repair criteria changed');
  const baseline = previous?.evaluation ?? original.evaluation;
  const errorPaths = failedLeaves(record.effectiveStages, baseline);
  if (!errorPaths.length) throw new Error('Measurement repair found no failed inference leaf');
  const repair = { originalStages: capturedRecord.effectiveStages, original: baseline, errorPaths };
  validateMeasurementRepair(record.effectiveStages, repair, options.native.registry);
  const id = await input.reserve();
  const observer = input.evaluation.observeJudgeAttempt;
  const evaluation = await freezeCriteria(input.dataset, { ...input.evaluation,
    observeJudgeAttempt: async attempt => {
      await options.native.store.appendEvent(report.id, { id: randomUUID(),
        payload: { type: 'judge.attempt', evaluationId: id, payload: attempt } }, 'evaluator');
      await observer?.(structuredClone(attempt));
    } }, options.native.registry);
  const measured = await evaluatePlan(record.effectiveStages, { ...evaluation, snapshot: structuredClone(original.snapshot),
    results: {}, scores: {}, signal: input.signal }, options.native.registry,
  repair);
  input.signal?.throwIfAborted();
  const gates = [result(measured.status, 'Repaired failed final measurements')];
  if (original.decisiveFailure) gates.push(original.decisiveFailure);
  const retainedCallIds = (measured.judgeCalls ?? []).filter(call =>
    baseline.judgeCalls?.some(previousCall => previousCall.id === call.id)).map(call => call.id);
  const repaired: RepairedMeasurement = {
    schema: 'paideia.rescore.v1', id, runId: report.id, scope: 'final-stages', notReevaluated: ['live', 'per-turn'],
    original: { evaluationId: source.id, digest: source.digest, candidateId: original.candidateId,
      datasetDigest: original.datasetDigest, planDigest: original.planDigest, recordId: original.recordId, phase: original.phase, status: original.status },
    criteria: { datasetId: input.dataset.id, datasetDigest: input.dataset.sourceDigest, sharedPlanDigest: input.dataset.sharedPlanDigest,
      stages: structuredClone(record.effectiveStages), registryVersions: input.dataset.registryVersions,
      sidecarDigests: input.dataset.criterionFileDigests,
      inferenceRoutes: {
        judges: Object.fromEntries(Object.entries(evaluation.judges).map(([name, route]) => [name,
          { providerId: route.provider.id, model: route.model, citationRepairs: route.citationRepairs ?? 0 }])),
        embeddings: Object.fromEntries(Object.entries(evaluation.embeddings).map(([name, route]) => [name,
          { providerId: route.id, version: route.version }])),
      } },
    execution: original.execution, hostWork: original.hostWork, coverage: structuredClone(original.snapshot.coverage),
    decisiveFailure: original.decisiveFailure, stop: original.stop, error: original.error,
    status: combine('all', gates).status, evaluation: measured,
    repair: { mode: 'errors-only', receiptDigest, errorPaths, retainedCallIds },
  };
  await options.native.store.appendEvaluation(report.id, { id, report: repaired }, 'evaluator');
  return repaired;
}
