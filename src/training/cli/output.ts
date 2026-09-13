import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { CandidateManifest } from '../candidates/index.js';
import { openExperimentStore, type ExperimentStore } from '../storage/index.js';
import type { InvocationIndex } from './types.js';

export async function withOutput<T>(root: string, operation: (store: ExperimentStore) => Promise<T>): Promise<T> {
  const store = await openExperimentStore(root);
  const lockPath = join(root, '.invocation.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') throw new Error(`Output is reserved by ${lockPath}; choose a fresh directory or verify the previous command stopped before removing its lock`, { cause: error });
    throw error;
  });
  try {
    try { await readFile(join(root, 'invocation.json')); throw new Error('Output already has an invocation index; select a fresh --out directory'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return await operation(store);
  } finally { await lock.close(); await unlink(lockPath); }
}

export async function persistResult(options: {
  root: string; store: ExperimentStore; id: string; command: 'evaluate' | 'train'; datasetId: string;
  planDigest: string; candidate: CandidateManifest; report: unknown; trialIds: string[];
  optimizerBudget?: { maxMetricCalls: number; maxProposals: number };
  outcome?: 'failed';
}): Promise<InvocationIndex> {
  const phase = options.command === 'train' && options.outcome !== 'failed' ? 'test' : 'train';
  await options.store.createRun({ schema: 'paideia.run.v1', id: options.id, datasetId: options.datasetId,
    datasetRole: phase, candidateId: options.candidate.id, planDigest: options.planDigest,
    ...(options.optimizerBudget ? { metadata: { optimizerBudget: options.optimizerBudget } } : {}) });
  const report = await options.store.putBlob(options.id, JSON.stringify(options.report), 'evaluator');
  const candidate = await options.store.putBlob(options.id, JSON.stringify(options.candidate), 'evaluator');
  const index: InvocationIndex = { schema: 'paideia.invocation.v1', command: options.command,
    ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
    summaryRunId: options.id, phase, candidateId: options.candidate.id, trialIds: options.trialIds, report, candidate };
  const bytes = `${JSON.stringify(index, null, 2)}\n`;
  const path = join(options.root, 'invocation.json');
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
  const directory = await open(options.root, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  if (await readFile(path, 'utf8') !== bytes) throw new Error('Invocation index did not persist faithfully');
  return index;
}
