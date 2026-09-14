import { configuredCostRoutes } from './training/index.js';
import { authoredArguments, judgeVersions, validateAuthoredTemplates } from './training/index.js';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { freezeCriteria, planTrainingCost, runStoredTrial, trainAgent, type StoredTrialOptions, type TrialReport } from '../experiments/index.js';
import { count, helpText, one, pairs, parseArguments, type CliArguments } from './arguments.js';
import { CliDatasets } from './datasets.js';
import { prepareCliInputs, prepareNative } from './native.js';
import { persistResult, withOutput } from './output.js';
import type { CliDependencies, CliIO } from './types.js';
import { startLiveViewer, viewInvocation } from './viewer.js';
import { dryRunTraining, readCostConfig } from './dry-run.js';
import { createFailureReport, createProgressJournal } from './progress/index.js';

async function execute(args: CliArguments, io: CliIO, dependencies: CliDependencies,
  timeoutMs: number, signal: AbortSignal): Promise<number> {
  if (args.command === 'view') {
    await viewInvocation(resolve(io.cwd, args.dataset!), count(args, 'port', 0, 65535, 0), io, signal);
    signal.throwIfAborted();
    return 0;
  }
  if (args.command === 'validate') {
    const dataset = new CliDatasets(pairs(args.flags.judge ?? []), io.cwd, {
      registry: { preparations: dependencies.spawnfile?.preparations },
      unlockedSetupPaths: dependencies.spawnfile?.unlockedSetupPaths,
    }, judgeVersions(args.training), args.frozenDataset).load(args.dataset!, false);
    io.stdout(`${JSON.stringify({ status: 'valid', datasetId: dataset.id, records: dataset.records.length,
      sourceDigest: dataset.sourceDigest, planDigest: dataset.sharedPlanDigest })}\n`);
    return 0;
  }
  if (args.command === 'train' && args.flags['dry-run']) return dryRunTraining(args, io, dependencies);
  if (args.flags['spawnfile-context'] && !dependencies.spawnfile) throw new Error('Spawnfile native training requires a supported isolated preparation integration; no native trial was started');
  const inputs = await prepareCliInputs(args, io, dependencies);
  const dataset = inputs.datasets.load(args.command === 'train' ? one(args, 'train') : args.dataset!, args.command === 'train');
  const test = args.command === 'train' ? inputs.datasets.load(one(args, 'test'), true) : undefined;
  if (args.command === 'evaluate' && dataset.records.length > inputs.maxTrials) throw new Error('Dataset exceeds --max-trials; no records are silently dropped');
  const metricCalls = inputs.maxTrials - (test === undefined ? 0 : 2 * test.records.length);
  if (metricCalls < 1) throw new Error('--max-trials cannot cover optimizer evaluation plus two reserved sealed-test passes');
  const bridgeCommand = args.command === 'train' ? one(args, 'bridge-command') : undefined;
  const optimizerModel = args.command === 'train' ? one(args, 'optimizer-model') : undefined;
  const maxProposals = count(args, 'max-proposals', 3, 1000);
  const seed = count(args, 'seed', 0, 2 ** 32 - 1, 0);
  const costConfig = readCostConfig(args, io);
  const costPlan = test === undefined ? undefined : planTrainingCost({ train: dataset, test,
    subjectModel: inputs.model, optimizerModel: optimizerModel!, validationGroups: args.flags['validation-group'],
    ...configuredCostRoutes(args, inputs.judges, inputs.citationRepairs),
    maxTrials: inputs.maxTrials, maxProposals, ...costConfig });
  const native = await prepareNative(args, io, dependencies, timeoutMs, inputs);
  signal.throwIfAborted();
  return withOutput(native.out, async (store) => {
    const base: Omit<StoredTrialOptions, 'id' | 'phase' | 'record' | 'candidate' | 'datasetId' | 'datasetDigest' | 'planDigest'> = {
      adapter: native.adapter, model: native.model, root: join(native.out, 'trials'), timeoutMs,
      registry: native.registry, evaluation: native.evaluation, resources: native.resources,
      prepareEnvironment: native.prepareEnvironment,
      store, storeRoot: native.out, protectedPaths: [native.sourceRoot, ...native.datasets.protectedDirectories], signal,
    };
    const id = randomUUID();
    const journal = await createProgressJournal({ id, datasetId: dataset.id, planDigest: dataset.sharedPlanDigest,
      candidateId: native.candidate.id, model: native.model, prices: costConfig.prices, store, io, costPlan });
    let live: Awaited<ReturnType<typeof startLiveViewer>> | undefined;
    let failed = false;
    try {
    live = args.flags.view === undefined ? undefined : await startLiveViewer({
      port: count(args, 'view', 0, 65535, 0), io, store, id, datasetId: dataset.id, planDigest: dataset.sharedPlanDigest,
      baseline: native.candidate, cases: dataset.records.map((record) => ({ id: record.id, split: 'train' })),
      testCases: test?.records.map((record) => ({ id: record.id, split: 'test' })) ?? [],
      budget: test === undefined ? undefined : { maxMetricCalls: metricCalls, maxProposals },
      costs: { subjectModel: native.model, prices: costConfig.prices, costPlan },
    });
    if (test !== undefined) {
      const report = await trainAgent({ id, baseline: native.candidate, train: dataset, test,
        validationGroups: args.flags['validation-group'], native: base,
        inference: { provider: native.inference, model: optimizerModel! },
        bridge: { command: bridgeCommand!.includes('/') ? resolve(io.cwd, bridgeCommand!) : bridgeCommand!, cwd: native.sourceRoot, timeoutMs },
        budget: { maxMetricCalls: metricCalls, maxProposals }, seed, signal,
        onProgress: async (event) => {
          await journal.observe(event);
          await live?.observe(event);
        },
      });
      signal.throwIfAborted();
      const index = await persistResult({ root: native.out, store, id, command: 'train', datasetId: test.id,
        planDigest: test.sharedPlanDigest, candidate: report.selected, report: { ...report, costs: journal.costs(), costPlan }, trialIds: report.trials.map((trial) => trial.id),
        optimizerBudget: { maxMetricCalls: metricCalls, maxProposals } });
      io.stdout(`${JSON.stringify({ status: 'completed', index: join(native.out, 'invocation.json'), ...index,
        evaluations: report.optimizer.provenance.evaluations, proposals: report.optimizer.provenance.proposals,
        costs: journal.summary(), estimatedApiEquivalentUsd: costPlan?.apiEquivalentUsd })}\n`);
      return report.trials.filter((trial) => trial.phase === 'test' && trial.candidateId === report.selected.id).every((trial) => trial.status === 'pass') ? 0 : 1;
    }
    const evaluation = await freezeCriteria(dataset, native.evaluation, native.registry);
    const trials: TrialReport[] = [];
    for (const record of dataset.records) {
      signal.throwIfAborted();
      const report = await runStoredTrial({ ...base, id: randomUUID(), phase: 'train', record, candidate: native.candidate,
        datasetId: dataset.id, datasetDigest: dataset.sourceDigest, planDigest: dataset.sharedPlanDigest, evaluation });
      trials.push(report); await journal.observe({ type: 'trial.finished', payload: report });
      await live?.observe({ type: 'trial.finished', payload: report });
    }
    signal.throwIfAborted();
    const index = await persistResult({ root: native.out, store, id, command: 'evaluate', datasetId: dataset.id,
      planDigest: dataset.sharedPlanDigest, candidate: native.candidate,
      report: { schema: 'paideia.cli-evaluation.v1', datasetId: dataset.id, candidateId: native.candidate.id, trials, costs: journal.costs() },
      trialIds: trials.map((trial) => trial.id) });
    await journal.observe({ type: 'evaluation.completed', payload: {} });
    io.stdout(`${JSON.stringify({ status: 'completed', index: join(native.out, 'invocation.json'), ...index, costs: journal.summary() })}\n`);
    await live?.observe({ type: 'evaluation.completed', payload: {} });
    if (trials.some((trial) => trial.execution === 'failed' || trial.status === 'error' || trial.status === 'unknown')) return 2;
    return trials.every((trial) => trial.status === 'pass') ? 0 : 1;
    } catch (error) {
      failed = true;
      try {
        const diagnostic = await journal.failed(error);
        const failureId = `failure-${id}`;
        const report = createFailureReport({ id: failureId, command: args.command as 'train' | 'evaluate',
          baseline: native.candidate, progressRunId: journal.runId, ...diagnostic, trials: journal.reports(),
          costs: journal.costs(), costPlan });
        await persistResult({ root: native.out, store, id: failureId, command: report.command,
          datasetId: dataset.id, planDigest: dataset.sharedPlanDigest, candidate: native.candidate,
          report, trialIds: report.view.trials.map(trial => trial.id), outcome: 'failed' });
      } catch { io.stderr('Failure report unavailable; original error preserved.\n'); }
      try { await live?.observe({ type: 'experiment.failed', payload: {} }); }
      catch { io.stderr('Failed viewer snapshot unavailable; original error preserved.\n'); }
      throw error;
    } finally {
      if (failed) await live?.close().catch(() => undefined);
      else await live?.close();
    }
  });
}

/** Injectable argv/IO and native boundaries; all command orchestration uses public owners. */
export async function main(argv: readonly string[], io: CliIO, dependencies: CliDependencies = {}): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const args = authoredArguments(parseArguments(argv), io);
    if (args.command === 'help') { io.stdout(helpText); return 0; }
    const timeoutMs = count(args, 'timeout-ms', 180000, 3600000);
    const deadline = new AbortController();
    timer = setTimeout(() => { timedOut = true; deadline.abort(); }, timeoutMs);
    timer.unref();
    const signal = io.signal === undefined ? deadline.signal : AbortSignal.any([deadline.signal, io.signal]);
    signal.throwIfAborted();
    await validateAuthoredTemplates(args, signal);
    const code = await execute(args, io, dependencies, timeoutMs, signal);
    // A persisted completion is authoritative even if cancellation arrives while closing optional UI.
    return code;
  } catch (error) {
    io.stderr(`${timedOut ? 'CLI command deadline exceeded' : error instanceof Error ? error.message : String(error)}\n`);
    return io.signal?.aborted === true && !timedOut ? 130 : 2;
  } finally { clearTimeout(timer); }
}
