import { open, readFile, mkdir, rename, link, unlink, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CandidateManifest } from '../candidates/index.js';
import { openExperimentStore, type ExperimentStore } from '../storage/index.js';
import type { InvocationIndex } from './types.js';
import { reserveOutput } from './training/index.js';

export async function withOutput<T>(root: string, operation: (store: ExperimentStore) => Promise<T>, resume = false): Promise<T> {
  const store = await openExperimentStore(root);
  const lockPath = join(root, '.invocation.lock');
  try {await readFile(lockPath); throw new Error(`Legacy output reservation exists; verify the previous command stopped before migrating its lock`);}
  catch(error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
  const release = await reserveOutput(root);
  try {
    try { await readFile(join(root, 'invocation.json')); if (!resume) throw new Error('Output already has an invocation index; select a fresh --out directory'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return await operation(store);
  } finally { release(); }
}

export async function persistResult(options: {
  root: string; store: ExperimentStore; id: string; command: 'evaluate' | 'train'; datasetId: string;
  planDigest: string; candidate: CandidateManifest; report: unknown; trialIds: string[];
  optimizerBudget?: { maxMetricCalls: number; maxProposals: number };
  outcome?: 'failed';
  replaceIndex?: boolean;
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
  const writtenPath = `${path}.${randomUUID()}.tmp`;
  const file = await open(writtenPath, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
  try {
    const historyRoot = join(options.root, 'invocations');
    await mkdir(historyRoot, { recursive: true, mode: 0o700 });
    await chmod(historyRoot, 0o700);
    await link(writtenPath, join(historyRoot, `${options.id}.json`));
    const historyDirectory = await open(historyRoot, 'r');
    try { await historyDirectory.sync(); } finally { await historyDirectory.close(); }
    if (options.replaceIndex) await rename(writtenPath, path);
    else await link(writtenPath, path);
  } finally { await unlink(writtenPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  const directory = await open(options.root, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  if (await readFile(path, 'utf8') !== bytes) throw new Error('Invocation index did not persist faithfully');
  return index;
}
