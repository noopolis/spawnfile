import { MutationQueue } from '../../platform/mutations/index.js';
import { recoverStoredReport } from './recovery.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, link, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ResolvedDataset } from '../../contracts/dataset.js';
import type { DspyResult } from '../../optimization/index.js';
import type { RescoreReport } from '../replay/index.js';
import type { TrialReport } from '../trials/index.js';
import type { CandidateManifest } from '../../candidates/index.js';
import type { TrainingOptions } from './training.js';

interface Entry { id: string; report?: TrialReport; rescores?: RescoreReport[]; pendingRescoreId?: string }
interface State {
  identity: string;
  entries: Record<string, Entry>;
  optimizer?: DspyResult;
  recoveries: number;
  lineage?: { parentIdentity: string; parentDigest: string; parentId: string; childId: string; inheritedTrialIds: string[] };
}
export const trainingDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Experiment identity and exact stored native trials; never an evaluation-result cache. */
export class TrainingCheckpoint {
  private readonly mutations = new MutationQueue();
  private readonly restored: Set<string>;
  private constructor(private readonly path: string, private state: State) { this.restored = new Set(Object.keys(state.entries)); }
  get inheritedTrialIds() { return [...this.state.lineage?.inheritedTrialIds ?? []]; }
  get optimizer() { return this.state.optimizer; }
  get rescores() { return Object.values(this.state.entries).flatMap(entry => entry.rescores ?? []); }
  get reports() { return Object.values(this.state.entries).flatMap(entry => entry.report ? [entry.report] : []); }

  static async open(options: TrainingOptions, datasets: ResolvedDataset[]) {
    if (!options.checkpoint) return undefined;
    const identity = trainingDigest({
      execution: options.checkpoint.identity, id: options.id, baseline: options.baseline, datasets,
      adapter: options.native.adapter.id, model: options.native.model, resources: options.native.resources,
      optimizer: { provider: options.inference.provider.id, model: options.inference.model },
      concurrency: options.concurrency, slots: options.slots, slotsFile: options.slotsFile,
      ...(options.testRepeats === undefined || options.testRepeats === 1 ? {} : { testRepeats: options.testRepeats }),
      ...(options.scoring?.deferred === 'stage-score' ? { scoring: options.scoring } : {}),
      seed: options.seed ?? 0, budget: options.budget, proposal: options.proposal, search: options.search, maxRecoveryAttempts: options.checkpoint.maxRecoveryAttempts ?? 2, versions: ['dspy3.3.1', 'gepa0.1.4', 'training-checkpoint1'],
    });
    return this.load(options, identity);
  }

  static async openComparison(options: Pick<TrainingOptions, 'id' | 'baseline' | 'native' | 'checkpoint'> & { candidate: CandidateManifest; name: string; maxTrials: number }, datasets: ResolvedDataset[]) {
    if (options.checkpoint?.fork) throw new Error('Comparison does not support measurement-repair forks');
    if (!options.checkpoint) return undefined;
    return this.load(options, trainingDigest({ version: 'paideia.comparison-checkpoint.v1',
      execution: options.checkpoint.identity, id: options.id, baseline: options.baseline, candidate: options.candidate,
      name: options.name, datasets, adapter: options.native.adapter.id, model: options.native.model,
      resources: options.native.resources, maxTrials: options.maxTrials, maxRecoveryAttempts: options.checkpoint.maxRecoveryAttempts ?? 2 }));
  }

  private static async load(options: Pick<TrainingOptions, 'id' | 'baseline' | 'native'> & { checkpoint?: TrainingOptions['checkpoint'] }, identity: string) {
    if (!options.checkpoint) return undefined;
    const path = join(options.checkpoint.directory, 'training.json');
    await mkdir(options.checkpoint.directory, { recursive: true, mode: 0o700 });
    let state: State = { identity, entries: {}, recoveries: 0 };
    let create = !options.checkpoint.resume;
    if (options.checkpoint.resume || options.checkpoint.fork) {
      let importing = !options.checkpoint.resume ? options.checkpoint.fork : undefined;
      let bytes: Buffer;
      try { bytes = await readFile(importing ? join(importing.directory, 'training.json') : path); }
      catch (error) {
        if (!options.checkpoint.resume || !options.checkpoint.fork || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if ((await readdir(options.checkpoint.directory)).some(name => name === 'host.json' || name === 'optimizer.json')) {
          throw new Error('Missing training checkpoint after optimizer initialization', { cause: error });
        }
        importing = options.checkpoint.fork; create = true;
        bytes = await readFile(join(importing.directory, 'training.json'));
      }
      if (importing && `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== importing.trainingDigest) {
        throw new Error('Parent training checkpoint digest mismatch');
      }
      const saved = JSON.parse(bytes.toString('utf8')) as { state: State; digest: string };
      if (saved.state.identity !== (importing ? importing.trainingIdentity : identity) || trainingDigest(saved.state) !== saved.digest) {
        throw new Error('Training checkpoint identity or integrity mismatch');
      }
      state = saved.state;
      if (importing) {
        if (!Number.isSafeInteger(state.recoveries) || state.recoveries < 0 || state.recoveries > (options.checkpoint.maxRecoveryAttempts ?? 2)) {
          throw new Error('Parent measurement recovery counter is invalid');
        }
        for (const entry of Object.values(state.entries)) {
          if (!entry.report || entry.id !== entry.report.id) throw new Error('Measurement fork requires settled captured native work');
          await recoverStoredReport(options, entry.id, entry.report.phase, entry.report.candidateId, entry.report);
        }
        state = { ...state, identity, lineage: { parentIdentity: importing.trainingIdentity,
          parentDigest: importing.trainingDigest, parentId: importing.id, childId: options.id,
          inheritedTrialIds: Object.values(state.entries).map(entry => entry.id) } };
      }
    }
    const checkpoint = new TrainingCheckpoint(path, state);
    if (create) await checkpoint.save(true);
    return checkpoint;
  }

  private transaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.mutations.run(async () => {
      const previous = structuredClone(this.state);
      try { return await operation(); }
      catch (error) { this.state = previous; throw error; }
    });
  }

  async begin(key: string): Promise<Entry & { restored: boolean }> {
    return this.transaction(() => this.beginMutation(key));
  }
  private async beginMutation(key: string): Promise<Entry & { restored: boolean }> {
    let entry = this.state.entries[key];
    if (!entry) { entry = { id: randomUUID() }; this.state.entries[key] = entry; await this.save(); }
    return { ...entry, restored: this.restored.delete(key) };
  }
  async complete(key: string, report: TrialReport) {
    return this.transaction(() => this.completeMutation(key, report));
  }
  private async completeMutation(key: string, report: TrialReport) {
    this.state.entries[key] = { id: report.id, report };
    await this.save();
  }
  async reserveRecovery(maximum: number, key?: string): Promise<string> {
    return this.transaction(() => this.reserveRecoveryMutation(maximum, key));
  }
  private async reserveRecoveryMutation(maximum: number, key?: string): Promise<string> {
    if (!Number.isSafeInteger(maximum) || maximum < 0 || this.state.recoveries >= maximum) throw new Error('Cumulative measurement recovery budget exhausted');
    const id = randomUUID();
    if (key) this.state.entries[key]!.pendingRescoreId = id;
    this.state.recoveries += 1; await this.save();
    return id;
  }
  async rescore(key: string, report: RescoreReport) {
    return this.transaction(() => this.rescoreMutation(key, report));
  }
  private async rescoreMutation(key: string, report: RescoreReport) {
    const entry = this.state.entries[key]!;
    (entry.rescores ??= []).push(report); await this.save();
  }
  async freeze(optimizer: DspyResult) {
    return this.transaction(() => this.freezeMutation(optimizer));
  }
  private async freezeMutation(optimizer: DspyResult) {
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
