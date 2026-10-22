import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { CandidateManifest } from '../../candidates/index.js';
import { candidateComponents, deriveCandidate } from '../../candidates/index.js';
import type { ResolvedDataset } from '../../contracts/dataset.js';
import { hydrateEvaluationJson, openExperimentStore, type ExperimentStore } from '../../storage/index.js';
import { capturedTrial } from '../replay/index.js';
import { trainingDigest } from '../training/index.js';
import type { TrialReport } from '../trials/index.js';
import type { MeasurementRepairReceipt } from './receipt.js';
import { repairDigest } from './receipt.js';

export async function readParentCheckpoints(receipt: MeasurementRepairReceipt) {
  const directory = join(receipt.parent.root, 'checkpoint');
  const read = async (name: keyof MeasurementRepairReceipt['parent']['checkpoints']) => {
    const bytes = await readFile(join(directory, `${name}.json`));
    if (bytes.length > 67_108_864 || repairDigest(bytes) !== receipt.parent.checkpoints[name]) {
      throw new Error(`Parent ${name} checkpoint bytes changed`);
    }
    return JSON.parse(bytes.toString('utf8'));
  };
  const [command, training, host] = await Promise.all([read('command'), read('training'), read('host')]);
  await read('optimizer');
  if (command.schema !== 'paideia.command-checkpoint.v1' || command.id !== receipt.parent.experimentId ||
      command.identity !== receipt.parent.executionIdentity || training.state?.identity !== receipt.parent.trainingIdentity ||
      trainingDigest(training.state) !== training.digest) throw new Error('Parent checkpoint identities disagree with repair authority');
  if (training.state.optimizer !== undefined) throw new Error('Measurement repair cannot reopen frozen selection or sealed tests');
  if (!Number.isSafeInteger(training.state.recoveries) || training.state.recoveries < 0 || !training.state.entries || !Array.isArray(host.entries)) {
    throw new Error('Parent checkpoint bookkeeping is invalid');
  }
  training.state = await hydrateEvaluationJson(await openExperimentStore(receipt.parent.root), training.state,
    { audience: 'operator', phase: 'replay' });
  return { directory, command, training, host };
}

/** Copy only integrity-checked development captures using storage's own ACLs. */
export async function importMeasurementCaptures(options: {
  receipt: MeasurementRepairReceipt; store: ExperimentStore; baseline: CandidateManifest;
  datasets: { train: ResolvedDataset; validation: ResolvedDataset };
}): Promise<TrialReport[]> {
  const parent = await readParentCheckpoints(options.receipt);
  const entries = Object.entries(parent.training.state.entries) as [string, { id: string; report?: TrialReport }][];
  if (!entries.length || entries.length > 10_000) throw new Error('Parent has no bounded native capture set');
  const source = await openExperimentStore(options.receipt.parent.root);
  const ids = new Set<string>();
  const reports: TrialReport[] = [];
  const access = { audience: 'operator' as const, phase: 'replay' as const };
  // Validate all identities before importing any capture or invoking any evaluator.
  const validated = await Promise.all(entries.map(async ([callbackId, entry]) => {
    if (!entry.report || entry.report.phase === 'test' || ids.has(entry.id)) throw new Error('Repair accepts unique settled development captures only');
    ids.add(entry.id);
    const callback = parent.host.entries.find((item: { request?: { id: string } }) => item.request?.id === callbackId);
    if (callback?.request.method !== 'evaluate') throw new Error('Native capture has no original optimizer evaluation callback');
    const params = callback.request.params;
    const baselineComponents = Object.fromEntries(candidateComponents(options.baseline).map(item => [item.id, item.text]));
    if (!isDeepStrictEqual(Object.keys(params.components).sort(), Object.keys(baselineComponents).sort())) throw new Error('Parent callback changed editable component keys');
    const candidate = isDeepStrictEqual(params.components, baselineComponents) ? options.baseline
      : deriveCandidate(options.baseline, options.baseline, params.components);
    const replay = await source.readReplay(entry.id, access);
    const { report } = capturedTrial(replay);
    if (!isDeepStrictEqual(report, entry.report)) throw new Error('Parent native report differs from its immutable capture');
    if (report.execution !== 'completed' || report.hostWork !== 'settled' || report.stop?.state !== 'acknowledged' ||
        report.stop.quiescence !== 'confirmed') throw new Error('Parent native closure is unverified');
    if (params.split !== report.phase || params.caseId !== report.recordId) throw new Error('Parent callback split or case identity differs');
    if (candidate.id !== report.candidateId) throw new Error('Parent candidate does not match the captured optimizer components');
    const dataset = options.datasets[report.phase as 'train' | 'validation'];
    const record = dataset.records.find(item => item.id === report.recordId);
    if (!record) throw new Error('Parent capture crosses current dataset partition');
    const blobs = await source.listBlobs(entry.id, access);
    const data = await Promise.all(blobs.map(async reference => ({ reference, bytes: await source.readBlob(reference, access) })));
    const json = data.flatMap(item => { try { return [JSON.parse(item.bytes.toString('utf8'))]; } catch { return []; } });
    const records = json.filter(value => value && value.id === record.id && Array.isArray(value.effectiveStages));
    if (records.length !== 1 || !isDeepStrictEqual(records[0], JSON.parse(JSON.stringify(record))) ||
        !json.some(value => isDeepStrictEqual(value, JSON.parse(JSON.stringify(candidate))))) {
      throw new Error('Parent protected record, criteria or candidate differs from current declarations');
    }
    return { replay, data, report };
  }));
  await readParentCheckpoints(options.receipt);
  for (const { replay, data, report } of validated) {
    await options.store.createRun(replay.manifest);
    for (const { reference, bytes } of data) {
      const copied = await options.store.putBlob(report.id, bytes, reference.visibility);
      const { visibility: _visibility, ...expected } = reference;
      if (!isDeepStrictEqual(copied, expected)) throw new Error('Imported blob provenance changed');
    }
    for (const event of replay.events) await options.store.appendEvent(report.id, { id: event.id, payload: event.payload }, event.visibility);
    for (const evaluation of replay.evaluations) await options.store.appendEvaluation(report.id,
      { id: evaluation.id, report: evaluation.report }, evaluation.visibility);
    reports.push(report);
  }
  return reports;
}
