import { z } from 'zod';
import type { Observation } from '../../contracts/execution.js';
import { createEvaluationRegistry } from '../../evaluation/index.js';
import { contentDigest, readStored, storedJsonDigest, writeTrialEvalFile,
  externalizeEvaluationJson, hydrateEvaluationJson, type Replay } from '../../storage/index.js';
import type { StoredTrialOptions } from '../trials/index.js';
import { portableReportSchema } from './schema.js';
import { capturedTrial, verifySnapshot } from './source.js';
import { rescoreFinalStages } from './rescore.js';

const schema = 'spawnfile.training.eval.v1';
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const envelope = z.strictObject({ schema: z.literal(schema), digest, payload: z.unknown() });
const stage = z.object({ id: z.string(), checks: z.array(z.record(z.string(), z.json())),
  gate: z.record(z.string(), z.json()).optional(), when: z.record(z.string(), z.json()).optional(),
  score: z.object({ linear: z.record(z.string(), z.number()) }).optional() });
const payloadSchema = z.strictObject({
  datasetId: z.string(), evaluationId: z.string(), evaluationDigest: digest,
  task: z.record(z.string(), z.json()), inputs: z.array(z.strictObject({ id: z.string(), input: z.string() })),
  stages: z.array(stage), sidecars: z.record(z.string(), z.string()), versions: z.record(z.string(), z.string()),
  report: z.unknown(), gradingBlobs: z.record(digest, z.string()),
});

function portableObservation(event: Observation): Observation {
  const { native: _native, ...rest } = event;
  if (rest.type !== 'diagnostic') return rest;
  const { id, source, seq, type, timestamp, trialId, wakeId, causalParents } = rest;
  return { id, source, seq, type, timestamp, trialId, wakeId, causalParents };
}

/** The authenticated report supplies evidence. Only staged stimuli and criterion reads supplement it. */
export async function writeTrialEval(options: Pick<StoredTrialOptions, 'storeRoot' | 'registry' | 'record'>, replay: Replay,
  inputs: { id: string; input: string }[], sidecars: Map<string, string>): Promise<string> {
  const { report, source } = capturedTrial(replay);
  const portable = portableReportSchema.parse(report);
  portable.snapshot.events = portable.snapshot.events.map(portableObservation);
  const { id, context, input, turns, outputs, reference, effectiveStages, live } = options.record;
  portable.snapshot.artifacts = Object.fromEntries(Object.entries(portable.snapshot.artifacts)
    .filter(([name, artifact]) => Object.hasOwn(outputs ?? {}, name) || name === 'reply' && artifact.provenance === 'trial-reply'));
  const versions = Object.fromEntries(Object.entries(options.registry).map(([key, entry]) => [key, entry.definition.version]));
  const gradingBlobs: Record<string, string> = {};
  const compact = await externalizeEvaluationJson({ async putBlob(runId, bytes) {
    const text = Buffer.from(bytes).toString('utf8');
    const digest = contentDigest(text);
    gradingBlobs[digest] = text;
    return { id: digest, runId, digest, size: Buffer.byteLength(text) };
  } }, report.id, portable);
  const payload = { datasetId: replay.manifest.datasetId, evaluationId: source.id, evaluationDigest: source.digest,
    task: { id, context, input, turns, outputs, reference, live }, inputs, stages: effectiveStages,
    sidecars: Object.fromEntries(sidecars), versions, report: compact, gradingBlobs };
  return writeTrialEvalFile(options.storeRoot, report.id, JSON.stringify({ schema, digest: storedJsonDigest(payload), payload }) + '\n');
}

export async function readTrialEval(path: string) {
  const file = envelope.parse(JSON.parse((await readStored(path)).toString('utf8')));
  if (file.digest !== storedJsonDigest(file.payload)) throw new Error('Trial eval payload digest mismatch');
  const data = payloadSchema.parse(file.payload);
  const report = portableReportSchema.parse(await hydrateEvaluationJson({ async readBlob(ref) {
    const bytes = data.gradingBlobs[ref.digest];
    if (typeof bytes !== 'string' || ref.id !== ref.digest || ref.size !== Buffer.byteLength(bytes) || contentDigest(bytes) !== ref.digest) {
      throw new Error('Trial eval grading blob integrity mismatch');
    }
    return Buffer.from(bytes);
  } }, data.report, { audience: 'evaluator', phase: 'replay' }));
  if (report.id !== report.snapshot.trialId || report.recordId !== report.snapshot.recordId || report.recordId !== data.task.id) {
    throw new Error('Trial eval identity mismatch');
  }
  verifySnapshot(report);
  return { ...data, report, digest: file.digest };
}

export async function regradeTrialEval(path: string, signal?: AbortSignal) {
  const file = await readTrialEval(path);
  const registry = createEvaluationRegistry();
  // Only installed versions used in the original run can grade the record offline.
  const available = Object.fromEntries(Object.entries(registry).filter(([key, entry]) => file.versions[key] === entry.definition.version));
  const { report, sidecars } = file;
  return rescoreFinalStages(report, { requireConfirmedClosure: true, id: 'regrade:' + file.digest, evaluationId: file.evaluationId, digest: file.evaluationDigest,
    criteria: { datasetId: file.datasetId, datasetDigest: report.datasetDigest, sharedPlanDigest: report.planDigest,
      stages: file.stages, registryVersions: Object.fromEntries(Object.entries(file.versions).map(([key, version]) => ['evaluator:' + key, version])),
      sidecarDigests: Object.fromEntries(Object.entries(sidecars).map(([name, bytes]) => [name, contentDigest(bytes)])),
      inferenceRoutes: { judges: {}, embeddings: {} } },
    registry: available, signal, evaluation: { judges: {}, embeddings: {}, readText: async name => {
      if (!Object.hasOwn(sidecars, name)) throw new Error('Criterion was not captured: ' + name);
      return sidecars[name]!;
    } } });
}
