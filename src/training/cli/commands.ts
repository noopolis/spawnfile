import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { freezeCriteria, runStoredTrial, trainAgent, type StoredTrialOptions, type TrialReport } from '../experiments/index.js';
import { count, helpText, one, pairs, parseArguments, type CliArguments } from './arguments.js';
import { CliDatasets } from './datasets.js';
import { prepareNative } from './native.js';
import { persistResult, withOutput } from './output.js';
import type { CliDependencies, CliIO } from './types.js';
import { startLiveViewer, viewInvocation } from './viewer.js';

function progress(io: CliIO, report: TrialReport): void {
  io.stdout(`${JSON.stringify({ trialId: report.id, phase: report.phase, candidateId: report.candidateId,
    status: report.status, execution: report.execution })}\n`);
}

async function execute(args: CliArguments, io: CliIO, dependencies: CliDependencies,
  timeoutMs: number, signal: AbortSignal): Promise<number> {
  if (args.command === 'view') {
    await viewInvocation(resolve(io.cwd, args.dataset!), count(args, 'port', 0, 65535, 0), io, signal);
    signal.throwIfAborted();
    return 0;
  }
  if (args.command === 'validate') {
    const dataset = new CliDatasets(pairs(args.flags.judge ?? []), io.cwd).load(args.dataset!, false);
    io.stdout(`${JSON.stringify({ status: 'valid', datasetId: dataset.id, records: dataset.records.length,
      sourceDigest: dataset.sourceDigest, planDigest: dataset.sharedPlanDigest })}\n`);
    return 0;
  }
  const native = await prepareNative(args, io, dependencies, timeoutMs);
  const dataset = native.datasets.load(args.command === 'train' ? one(args, 'train') : args.dataset!, args.command === 'train');
  const test = args.command === 'train' ? native.datasets.load(one(args, 'test'), true) : undefined;
  if (args.command === 'evaluate' && dataset.records.length > native.maxTrials) throw new Error('Dataset exceeds --max-trials; no records are silently dropped');
  const metricCalls = native.maxTrials - (test === undefined ? 0 : 2 * test.records.length);
  if (metricCalls < 1) throw new Error('--max-trials cannot cover optimizer evaluation plus two reserved sealed-test passes');
  const bridgeCommand = args.command === 'train' ? one(args, 'bridge-command') : undefined;
  const optimizerModel = args.command === 'train' ? one(args, 'optimizer-model') : undefined;
  const maxProposals = count(args, 'max-proposals', 3, 1000);
  const seed = count(args, 'seed', 0, 2 ** 32 - 1, 0);
  signal.throwIfAborted();
  return withOutput(native.out, async (store) => {
    const base: Omit<StoredTrialOptions, 'id' | 'phase' | 'record' | 'candidate' | 'datasetId' | 'datasetDigest' | 'planDigest'> = {
      adapter: native.adapter, model: native.model, root: join(native.out, 'trials'), timeoutMs,
      registry: native.registry, evaluation: native.evaluation, resources: native.resources,
      store, storeRoot: native.out, protectedPaths: [native.sourceRoot, ...native.datasets.protectedDirectories], signal,
    };
    const id = randomUUID();
    const live = args.flags.view === undefined ? undefined : await startLiveViewer({
      port: count(args, 'view', 0, 65535, 0), io, store, id, datasetId: dataset.id, planDigest: dataset.sharedPlanDigest,
      baseline: native.candidate, cases: dataset.records.map((record) => ({ id: record.id, split: 'train' })),
      testCases: test?.records.map((record) => ({ id: record.id, split: 'test' })) ?? [],
      budget: test === undefined ? undefined : { maxMetricCalls: metricCalls, maxProposals },
    });
    try {
    if (test !== undefined) {
      const report = await trainAgent({ id, baseline: native.candidate, train: dataset, test,
        validationGroups: args.flags['validation-group'], native: base,
        inference: { provider: native.inference, model: optimizerModel! },
        bridge: { command: bridgeCommand!.includes('/') ? resolve(io.cwd, bridgeCommand!) : bridgeCommand!, cwd: native.sourceRoot, timeoutMs },
        budget: { maxMetricCalls: metricCalls, maxProposals }, seed, signal,
        onProgress: async (event) => {
          if (event.type === 'trial.finished') progress(io, event.payload as TrialReport);
          await live?.observe(event);
        },
      });
      signal.throwIfAborted();
      const index = await persistResult({ root: native.out, store, id, command: 'train', datasetId: test.id,
        planDigest: test.sharedPlanDigest, candidate: report.selected, report, trialIds: report.trials.map((trial) => trial.id),
        optimizerBudget: { maxMetricCalls: metricCalls, maxProposals } });
      io.stdout(`${JSON.stringify({ status: 'completed', index: join(native.out, 'invocation.json'), ...index,
        evaluations: report.optimizer.provenance.evaluations, proposals: report.optimizer.provenance.proposals })}\n`);
      return report.trials.filter((trial) => trial.phase === 'test' && trial.candidateId === report.selected.id).every((trial) => trial.status === 'pass') ? 0 : 1;
    }
    const evaluation = await freezeCriteria(dataset, native.evaluation, native.registry);
    const trials: TrialReport[] = [];
    for (const record of dataset.records) {
      signal.throwIfAborted();
      const report = await runStoredTrial({ ...base, id: randomUUID(), phase: 'train', record, candidate: native.candidate,
        datasetId: dataset.id, datasetDigest: dataset.sourceDigest, planDigest: dataset.sharedPlanDigest, evaluation });
      trials.push(report); progress(io, report);
      await live?.observe({ type: 'trial.finished', payload: report });
    }
    signal.throwIfAborted();
    const index = await persistResult({ root: native.out, store, id, command: 'evaluate', datasetId: dataset.id,
      planDigest: dataset.sharedPlanDigest, candidate: native.candidate,
      report: { schema: 'paideia.cli-evaluation.v1', datasetId: dataset.id, candidateId: native.candidate.id, trials },
      trialIds: trials.map((trial) => trial.id) });
    io.stdout(`${JSON.stringify({ status: 'completed', index: join(native.out, 'invocation.json'), ...index })}\n`);
    await live?.observe({ type: 'evaluation.completed', payload: {} });
    if (trials.some((trial) => trial.execution === 'failed' || trial.status === 'error' || trial.status === 'unknown')) return 2;
    return trials.every((trial) => trial.status === 'pass') ? 0 : 1;
    } finally { await live?.close(); }
  });
}

/** Injectable argv/IO and native boundaries; all command orchestration uses public owners. */
export async function main(argv: readonly string[], io: CliIO, dependencies: CliDependencies = {}): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const args = parseArguments(argv);
    if (args.command === 'help') { io.stdout(helpText); return 0; }
    const timeoutMs = count(args, 'timeout-ms', 180000, 3600000);
    const deadline = new AbortController();
    timer = setTimeout(() => { timedOut = true; deadline.abort(); }, timeoutMs);
    timer.unref();
    const signal = io.signal === undefined ? deadline.signal : AbortSignal.any([deadline.signal, io.signal]);
    signal.throwIfAborted();
    const code = await execute(args, io, dependencies, timeoutMs, signal);
    // A persisted completion is authoritative even if cancellation arrives while closing optional UI.
    return code;
  } catch (error) {
    io.stderr(`${timedOut ? 'CLI command deadline exceeded' : error instanceof Error ? error.message : String(error)}\n`);
    return io.signal?.aborted === true && !timedOut ? 130 : 2;
  } finally { clearTimeout(timer); }
}
