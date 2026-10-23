import { randomUUID } from 'node:crypto';
import { combine, evaluatePlan, result } from '../../evaluation/index.js';
import { freezeCriteria } from '../training/index.js';
import { capturedTrial } from './source.js';
import type { RescoreOptions, RescoreReport } from './types.js';

/** Explicit evaluator work over frozen evidence. This function has no subject-adapter dependency. */
export async function rescoreStoredTrial(options: RescoreOptions): Promise<RescoreReport> {
  if (options.access.audience !== 'evaluator' && options.access.audience !== 'operator') throw new Error('Rescore requires evaluator or operator access');
  if (!options.id || options.id.length > 512 || options.id.includes('\0')) throw new Error('Rescore requires a valid immutable evaluation ID');
  const dataset = structuredClone(options.dataset);
  const judges = Object.fromEntries(Object.entries(options.evaluation.judges).map(([name, route]) => [name, { ...route }]));
  const embeddings = { ...options.evaluation.embeddings };
  const inferenceRoutes = {
    judges: Object.fromEntries(Object.entries(judges).map(([name, route]) => [name, { providerId: route.provider.id, model: route.model, citationRepairs: route.citationRepairs ?? 0 }])),
    embeddings: Object.fromEntries(Object.entries(embeddings).map(([name, route]) => [name, { providerId: route.id, version: route.version }])),
  };
  const replay = await options.store.readReplay(options.runId, options.access);
  const { report: original, source } = capturedTrial(replay);
  if (replay.evaluations.some(entry => entry.id === options.id)) throw new Error('Rescore evaluation ID already exists');
  const records = dataset.records.filter(record => record.id === original.recordId);
  if (records.length !== 1) throw new Error('New criteria must select the original record exactly once');
  const record = records[0]!;
  if (record.turns?.some(turn => turn.checks?.length)) throw new Error('Per-turn rescoring requires stored turn snapshots; only final stages are supported');
  if (!record.effectiveStages.length) throw new Error('Rescore requires a nonempty final-stage plan');
  const observer = options.evaluation.observeJudgeAttempt;
  const evaluationContext = await freezeCriteria(dataset, { ...options.evaluation, judges, embeddings,
    observeJudgeAttempt: async attempt => {
      await options.store.appendEvent(options.runId, { id: randomUUID(),
        payload: { type: 'judge.attempt', evaluationId: options.id, payload: attempt } }, 'evaluator');
      await observer?.(structuredClone(attempt));
    } }, options.registry);
  if (options.signal?.aborted) throw new Error('Rescore cancelled before evaluation');
  const evaluation = await evaluatePlan(structuredClone(record.effectiveStages), { ...evaluationContext, snapshot: structuredClone(original.snapshot),
    results: {}, scores: {}, signal: options.signal }, options.registry);
  if (options.signal?.aborted) throw new Error('Rescore cancelled during evaluation');
  const gates = [result(evaluation.status, 'Rescored final-stage plan')];
  if (original.decisiveFailure) gates.push(original.decisiveFailure);
  if (original.execution !== 'completed' || original.hostWork !== 'settled' || original.stop?.state !== 'acknowledged') {
    gates.push(result('error', 'Original native execution or cleanup remains incomplete'));
  }
  const report: RescoreReport = {
    schema: 'paideia.rescore.v1', id: options.id, runId: options.runId, scope: 'final-stages', notReevaluated: ['live', 'per-turn'],
    original: { evaluationId: source.id, digest: source.digest, candidateId: original.candidateId, datasetDigest: original.datasetDigest,
      planDigest: original.planDigest, recordId: original.recordId, phase: original.phase, status: original.status },
    criteria: { datasetId: dataset.id, datasetDigest: dataset.sourceDigest, sharedPlanDigest: dataset.sharedPlanDigest,
      stages: record.effectiveStages,
      registryVersions: dataset.registryVersions, sidecarDigests: dataset.criterionFileDigests, inferenceRoutes },
    execution: original.execution, hostWork: original.hostWork, coverage: structuredClone(original.snapshot.coverage),
    decisiveFailure: original.decisiveFailure, stop: original.stop, error: original.error,
    status: combine('all', gates).status, evaluation,
  };
  await options.store.appendEvaluation(options.runId, { id: options.id, report }, 'evaluator');
  return report;
}
