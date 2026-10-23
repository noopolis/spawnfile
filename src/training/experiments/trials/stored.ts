import { randomUUID } from 'node:crypto';
import type { CandidateManifest } from '../../candidates/index.js';
import { materializeCandidate, validateCandidate } from '../../candidates/index.js';
import type { ExperimentStore } from '../../storage/index.js';
import type { TrialOptions, TrialReport, TrialEvent } from './types.js';
import { runTrial } from './trial.js';

/** Evaluator-owned preparation data; never implicitly delivered to the subject. */
export interface NativePreparationContext {
  slot?: TrialOptions['slot'];
  id: string;
  phase: TrialOptions['phase'];
  record: TrialOptions['record'];
  candidate: CandidateManifest;
  resources: Record<string, string>;
}

export interface StoredTrialOptions extends Omit<TrialOptions, 'candidateId' | 'persist' | 'prepare'> {
  datasetId: string;
  candidate: CandidateManifest;
  store: ExperimentStore;
  storeRoot: string;
  /** Called only after the event has reached the protected durable store. */
  observeEvent?: (event: TrialEvent) => Promise<void>;
  /** The environment may install tools/state; instructions come from declared candidate resources. */
  prepareEnvironment?: (paths: Parameters<TrialOptions['prepare']>[0], signal: AbortSignal,
    context: NativePreparationContext) => Promise<Omit<Awaited<ReturnType<TrialOptions['prepare']>>, 'instructions'>>;
}
export async function runStoredTrial(options: StoredTrialOptions): Promise<TrialReport> {
  if ('schema' in options.record && options.record.schema === 'paideia.cost-record.v1') throw new Error('Cost-only records cannot execute trials');
  validateCandidate(options.candidate);
  const instructions = options.candidate.resources.filter(resource => resource.destinations.some(destination => destination.kind === 'instructions'));
  if (!instructions.length) throw new Error('Candidate has no native instruction resource');
  for (const resource of options.candidate.resources) {
    for (const destination of resource.destinations) {
      if (!options.adapter.capabilities.resources.includes(destination.kind)) throw new Error(`Adapter does not support ${destination.kind}`);
    }
  }
  if (options.record.setup && !options.prepareEnvironment) throw new Error('Record requires a registered native environment preparation');
  await options.store.createRun({ schema: 'paideia.run.v1', id: options.id, datasetId: options.datasetId,
    datasetRole: options.phase, candidateId: options.candidate.id, planDigest: options.planDigest, recordId: options.record.id,
    metadata: { adapter: options.adapter.id, model: options.model, timeoutMs: options.timeoutMs } });
  await options.store.putBlob(options.id, JSON.stringify(options.candidate), 'evaluator');
  await options.store.putBlob(options.id, JSON.stringify(options.record), 'evaluator');
  const report = await runTrial({ ...options, candidateId: options.candidate.id,
    protectedPaths: [options.storeRoot, ...(options.protectedPaths ?? [])],
    persist: async event => {
      await options.store.appendEvent(options.id, { id: randomUUID(), payload: event }, 'raw');
      await options.observeEvent?.(event);
    },
    prepare: async (paths, signal) => {
      const receipts = await materializeCandidate(options.candidate, paths.workspace);
      const environment = await options.prepareEnvironment?.(paths, signal, structuredClone({
        id: options.id, phase: options.phase, record: options.record, slot: options.slot,
        candidate: options.candidate, resources: { ...options.resources },
      }));
      await options.store.appendEvent(options.id, { id: randomUUID(), payload: { type: 'candidate.installed', receipts } }, 'evaluator');
      return { ...environment, instructions: instructions.map(resource => resource.content).join('\n\n') };
    } });
  report.candidate = structuredClone(options.candidate);
  if (options.round !== undefined) report.round = options.round;
  await options.store.appendEvaluation(options.id, { id: randomUUID(), report }, 'evaluator');
  return report;
}
