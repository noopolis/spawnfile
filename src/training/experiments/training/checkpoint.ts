import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, link, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ResolvedDataset } from '../../contracts/dataset.js';
import type { DspyResult } from '../../optimization/index.js';
import type { RescoreReport } from '../replay/index.js';
import type { TrialReport } from '../trials/index.js';
import type { TrainingOptions } from './training.js';

interface Entry { id: string; report?: TrialReport; rescores?: RescoreReport[]; pendingRescoreId?: string }
interface State {
  identity: string;
  entries: Record<string, Entry>;
  optimizer?: DspyResult;
  recoveries: number;
}
export const trainingDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Experiment identity and exact stored native trials; never an evaluation-result cache. */
export class TrainingCheckpoint {
  private readonly restored: Set<string>;
  private constructor(private readonly path: string, private readonly state: State) { this.restored = new Set(Object.keys(state.entries)); }
  get optimizer() { return this.state.optimizer; }
  get rescores() { return Object.values(this.state.entries).flatMap(entry => entry.rescores ?? []); }
  get reports() { return Object.values(this.state.entries).flatMap(entry => entry.report ? [entry.report] : []); }

  static async open(options: TrainingOptions, datasets: ResolvedDataset[]) {
    if (!options.checkpoint) return undefined;
    const identity = trainingDigest({
      execution: options.checkpoint.identity, id: options.id, baseline: options.baseline, datasets,
      adapter: options.native.adapter.id, model: options.native.model, resources: options.native.resources,
      optimizer: { provider: options.inference.provider.id, model: options.inference.model },
      seed: options.seed ?? 0, budget: options.budget, proposal: options.proposal, maxRecoveryAttempts: options.checkpoint.maxRecoveryAttempts ?? 2, versions: ['dspy3.3.1', 'gepa0.1.4', 'training-checkpoint1'],
    });
    const path = join(options.checkpoint.directory, 'training.json');
    await mkdir(options.checkpoint.directory, { recursive: true, mode: 0o700 });
    let state: State = { identity, entries: {}, recoveries: 0 };
    if (options.checkpoint.resume) {
      const saved = JSON.parse(await readFile(path, 'utf8')) as { state: State; digest: string };
      if (saved.state.identity !== identity || trainingDigest(saved.state) !== saved.digest) throw new Error('Training checkpoint identity or integrity mismatch');
      state = saved.state;
    }
    const checkpoint = new TrainingCheckpoint(path, state);
    if (!options.checkpoint.resume) await checkpoint.save(true);
    return checkpoint;
  }

  async begin(key: string): Promise<Entry & { restored: boolean }> {
    let entry = this.state.entries[key];
    if (!entry) { entry = { id: randomUUID() }; this.state.entries[key] = entry; await this.save(); }
    return { ...entry, restored: this.restored.delete(key) };
  }
  async complete(key: string, report: TrialReport) {
    this.state.entries[key] = { id: report.id, report };
    await this.save();
  }
  async reserveRecovery(maximum: number, key?: string): Promise<string> {
    if (!Number.isSafeInteger(maximum) || maximum < 0 || this.state.recoveries >= maximum) throw new Error('Cumulative measurement recovery budget exhausted');
    const id = randomUUID();
    if (key) this.state.entries[key]!.pendingRescoreId = id;
    this.state.recoveries += 1; await this.save();
    return id;
  }
  async rescore(key: string, report: RescoreReport) {
    const entry = this.state.entries[key]!;
    (entry.rescores ??= []).push(report); await this.save();
  }
  async freeze(optimizer: DspyResult) {
    if (this.state.optimizer && trainingDigest(this.state.optimizer) !== trainingDigest(optimizer)) throw new Error('Frozen optimizer selection cannot change on resume');
    this.state.optimizer = optimizer; await this.save();
  }
  private async save(create = false) {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ state: this.state, digest: trainingDigest(this.state) })); await file.sync(); }
    finally { await file.close(); }
    try { if (create) await link(temp, this.path); else await rename(temp, this.path); }
    finally { await unlink(temp).catch(() => undefined); }
    const directory = await open(dirname(this.path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
