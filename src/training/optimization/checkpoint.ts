import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, open, link, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { InferenceResult } from '../contracts/execution.js';
import { requestSchema, evaluationSchema, inferenceSchema, startSchema, DSPY_SCHEMA, type DspyRequest, type DspyStart } from './protocol.js';
import type { DspyOptimizationOptions, DspyRestoredEvidence } from './types.js';

export interface CallbackEntry {
  request: DspyRequest;
  attempts: number;
  result?: unknown;
  inference?: InferenceResult;
  failedAttempts?: InferenceResult['attempts'];
  settledFailures?: number;
}
const canonical = (value: unknown) => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function generationResult(inference: InferenceResult) {
  return { text: inference.text, model: inference.model, usage: inference.usage,
    ...(inference.modelBasis === undefined ? {} : { modelBasis: inference.modelBasis }) };
}

/** Protected host journal. Completed callbacks replay; incomplete callbacks consume a new attempt. */
export class OptimizationCheckpoint {
  private history: CallbackEntry[] = [];
  get entries(): readonly CallbackEntry[] { return structuredClone(this.history); }
  private constructor(private readonly path: string, private readonly identity: string) {}

  static async open(start: DspyStart, options: NonNullable<DspyOptimizationOptions['checkpoint']>) {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const checkpoint = new OptimizationCheckpoint(join(options.directory, 'host.json'), digest({
      start: { ...start, checkpoint: undefined, recovery: undefined }, execution: options.identity, bridge: 'dspy3.3.1-gepa0.1.4-checkpoint1',
    }));
    if (options.resume) {
      const raw = JSON.parse(await readFile(checkpoint.path, 'utf8')) as { identity: string; entries: CallbackEntry[]; digest: string };
      if (raw.identity !== checkpoint.identity || digest({ identity: raw.identity, entries: raw.entries }) !== raw.digest) {
        throw new Error('Optimizer checkpoint identity or integrity mismatch');
      }
      const ids = new Set<string>();
      for (const entry of raw.entries) {
        requestSchema.parse(entry.request);
        if (ids.has(entry.request.id) || !Number.isSafeInteger(entry.attempts) || entry.attempts < 1) throw new Error('Invalid checkpoint callback history');
        ids.add(entry.request.id);
        checkpoint.validateResult(entry);
        checkpoint.history.push(entry);
      }
    } else { await checkpoint.save([], true); }
    return checkpoint;
  }

  async begin(request: DspyRequest, budget: DspyStart['budget']): Promise<CallbackEntry> {
    requestSchema.parse(request);
    let entry = this.history.find(item => item.request.id === request.id);
    if (entry && canonical(entry.request) !== canonical(request)) throw new Error('Resumed optimizer callback diverged from its checkpoint');
    if (entry?.result !== undefined) return structuredClone(entry);
    const limit = request.method === 'evaluate' ? budget.maxMetricCalls : budget.maxProposals;
    const spent = this.history.filter(item => item.request.method === request.method).reduce((sum, item) => sum + item.attempts, 0);
    if (spent >= limit) throw new Error(`Cumulative ${request.method} attempt budget exhausted`);
    entry = { ...entry, request, attempts: (entry?.attempts ?? 0) + 1 };
    const history = this.history.filter(item => item.request.id !== request.id);
    history.push(entry);
    await this.save(history);
    this.history = history;
    return structuredClone(entry);
  }

  async complete(entry: CallbackEntry, result: unknown, inference?: InferenceResult) {
    const index = this.history.findIndex(item => item.request.id === entry.request.id);
    const original = this.history[index];
    if (!original || original.result !== undefined || canonical(original) !== canonical(entry)) throw new Error('Callback completion is not a pending journal entry');
    const completed = { ...original, result, ...(inference ? { inference } : {}) };
    this.validateResult(completed);
    const history = [...this.history]; history[index] = structuredClone(completed);
    await this.save(history);
    this.history = history;
  }

  async failed(entry: CallbackEntry, attempts: NonNullable<InferenceResult['attempts']>) {
    const index = this.history.findIndex(item => item.request.id === entry.request.id);
    const original = this.history[index];
    if (!original || original.result !== undefined || canonical(original) !== canonical(entry)) throw new Error('Failed callback is not a pending journal entry');
    inferenceSchema.pick({ attempts: true }).parse({ attempts });
    const history = structuredClone(this.history);
    if (attempts.length) history[index]!.settledFailures = (history[index]!.settledFailures ?? 0) + 1;
    history[index]!.failedAttempts = [...history[index]!.failedAttempts ?? [], ...attempts];
    await this.save(history); this.history = history;
  }

  private validateResult(entry: CallbackEntry) {
    if (entry.failedAttempts) inferenceSchema.pick({ attempts: true }).parse({ attempts: entry.failedAttempts });
    if (entry.result === undefined) return;
    if (entry.request.method === 'evaluate') evaluationSchema.parse(entry.result);
    else {
      const inference = inferenceSchema.parse(entry.inference);
      if (canonical(generationResult(inference)) !== canonical(entry.result)) throw new Error('Persisted generation differs from host inference evidence');
    }
  }

  private async save(entries: CallbackEntry[], create = false) {
    const payload = { identity: this.identity, entries };
    const target = `${this.path}.${randomUUID()}.tmp`;
    const handle = await open(target, 'wx', 0o600);
    try { await handle.writeFile(canonical({ ...payload, digest: digest(payload) })); await handle.sync(); }
    finally { await handle.close(); }
    try { if (create) await link(target, this.path); else await rename(target, this.path); }
    finally { await unlink(target).catch(() => undefined); }
    const directory = await open(dirname(this.path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

export function restoredDspyEvidence(checkpoint: OptimizationCheckpoint): DspyRestoredEvidence {
  return {
    generations: checkpoint.entries.flatMap(entry => entry.inference ? [{
      callbackId: entry.request.id, model: entry.inference.model, modelBasis: entry.inference.modelBasis,
      route: entry.inference.route, usage: entry.inference.usage, attempts: entry.inference.attempts,
    }] : []),
    failedAttempts: checkpoint.entries.flatMap(entry => entry.failedAttempts ?? []),
    reservations: checkpoint.entries.map(entry => ({ id: entry.request.id, method: entry.request.method,
      attempts: entry.attempts, settledAttempts: (entry.settledFailures ?? 0) + (entry.result === undefined ? 0 : 1),
      completed: entry.result !== undefined })),
  };
}

/** Accounting-only restore; validates identity and never starts Python or inference. */
export async function readDspyCheckpointEvidence(options: Pick<DspyOptimizationOptions,
  'id' | 'components' | 'trainCaseIds' | 'validationCaseIds' | 'budget' | 'seed' | 'proposal'> & {
    checkpoint: NonNullable<DspyOptimizationOptions['checkpoint']>;
  }): Promise<DspyRestoredEvidence> {
  const start = startSchema.parse({ schema: DSPY_SCHEMA, kind: 'optimize', id: options.id,
    components: options.components, trainCaseIds: options.trainCaseIds, validationCaseIds: options.validationCaseIds,
    budget: options.budget, seed: options.seed, proposal: options.proposal });
  return restoredDspyEvidence(await OptimizationCheckpoint.open(start, { ...options.checkpoint, resume: true }));
}
