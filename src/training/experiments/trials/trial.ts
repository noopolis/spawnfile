import { mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { EvaluationSnapshot, EvaluationResult } from '../../contracts/evaluation.js';
import type { Observation, ObservationCoverage } from '../../contracts/execution.js';
import { captureObservation } from '../../capture/index.js';
import { combine, evaluatePlan, mayStop, result } from '../../evaluation/index.js';
import { captureBindings, resolveTurnInput } from './bindings.js';
import { collectOutputs, stageInput } from './files.js';
import { createLiveMonitor } from './live.js';
import { trialControl } from './control.js';
import { requireMechanicalTurn } from './preflight.js';
import { drainObservations } from './closure.js';
import type { PreparedTrial, TrialOptions, TrialPaths, TrialReport, TurnReport } from './types.js';

export async function runTrial(options: TrialOptions): Promise<TrialReport> {
  const { adapter, registry } = options;
  const record = structuredClone(options.record);
  if (!options.id || !options.model) throw new Error('Trial identity and model are required');
  const inputs = record.turns ?? [{ id: 'task', input: record.input! }];
  if (!inputs.length || inputs.some(turn => !turn.input)) throw new Error('No trial stimuli');
  if (inputs.length > 1 && !adapter.capabilities.multiTurn) throw new Error('Adapter cannot preserve multiple native wakes');
  for (const turn of record.turns ?? []) requireMechanicalTurn(turn.checks ?? [], registry);
  for (const check of record.live.checks) {
    if (mayStop(check, registry) && (!adapter.capabilities.liveObservations || adapter.capabilities.cancellation === 'none')) {
      throw new Error('Selected hard stop requires native observation and cancellation');
    }
  }
  if (adapter.capabilities.readIsolation !== 'declared-paths' || !adapter.capabilities.protectedPaths) {
    throw new Error('Trial requires native protection for evaluator-owned files');
  }
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(resolve(options.root), 'trial-'));
  const paths: TrialPaths = { root, workspace: join(root, 'workspace'), control: join(root, 'control'), runtimeHome: join(root, 'runtime') };
  await Promise.all([paths.workspace, paths.control, paths.runtimeHome].map(path => mkdir(path, { mode: 0o700 })));
  const control = trialControl(options.timeoutMs, options.signal);
  const turns: TurnReport[] = [];
  let events: Observation[] = [];
  let coverage: ObservationCoverage[] = [{ channel: 'tools', completeness: 'partial', ordering: 'none' },
    { channel: 'output', completeness: 'partial', ordering: 'source' }];
  let output = '';
  let prepared: PreparedTrial | undefined;
  let error: string | undefined;
  let execution: TrialReport['execution'] = 'completed';
  let sinkFailed = false;
  let closed = false;
  let observationTail = Promise.resolve();
  let observationFailure: string | undefined;
  const inputFiles: Record<string, string> = {};
  const bindings: Record<string, unknown> = {};
  const persist = async (type: string, payload: unknown) => {
    try { await options.persist({ type, payload }); }
    catch (error) { sinkFailed = true; control.stop('Evidence persistence failed'); throw error; }
  };
  const snapshot = async (): Promise<EvaluationSnapshot> => ({ trialId: options.id, recordId: record.id, closed,
    events: structuredClone(events), coverage: structuredClone(coverage), output, inputFiles: { ...inputFiles }, context: record.context ?? {},
    artifacts: { ...await collectOutputs(record.outputs ?? {}, paths.workspace, `${options.id}/${events.length}`), ...await prepared?.collect?.() } });
  const live = createLiveMonitor({ checks: record.live.checks, registry, evaluation: options.evaluation,
    persist: entry => persist('live.evaluation', entry), stop: why => control.stop(why, 'decisive'), signal: control.signal });
  const evaluate = (state: EvaluationSnapshot) => ({ ...options.evaluation, snapshot: state, results: {}, scores: {}, signal: control.signal });
  try {
    await persist('trial.started', { id: options.id, phase: options.phase, candidateId: options.candidateId,
      datasetDigest: options.datasetDigest, planDigest: options.planDigest, recordId: record.id,
      adapter: adapter.id, capabilities: adapter.capabilities, model: options.model, timeoutMs: options.timeoutMs });
    prepared = await control.owned(options.prepare(paths, control.signal));
    if (control.signal.aborted) throw new Error(control.reason);
    const session = await control.owned(adapter.start({ trialId: options.id, workspacePath: paths.workspace,
      runtimeHomePath: paths.runtimeHome, instructions: prepared.instructions, tools: prepared.tools, model: options.model,
      protectedPaths: [resolve(options.root), paths.control, paths.runtimeHome, ...Object.values(options.resources ?? {}), ...(options.protectedPaths ?? [])],
      signal: control.signal,
      onObservation: event => {
        const operation = observationTail.then(async () => {
        if (closed) throw new Error('Adapter emitted after trial closure');
        if (event.trialId !== options.id) throw new Error('Observation belongs to another trial');
        const next = captureObservation(events, event);
        if (next.length === events.length) return;
        await persist('observation', event);
        if (closed) throw new Error('Observation persisted after trial closure');
        events = next;
        if (event.type === 'output') output = event.text ?? '';
        const state = await snapshot();
        if (closed) throw new Error('Observation collected after trial closure');
        await live.checkpoint(state, event.id);
        }).catch(caught => { observationFailure = String(caught); control.stop('Native observation failed'); throw caught; });
        observationTail = operation.catch(() => undefined);
        return control.owned(operation);
      } }).then(session => { control.attach(session); return session; }));
    for (const turn of inputs) {
      if (control.signal.aborted) break;
      const text = await stageInput(resolveTurnInput(turn.input, bindings), paths.workspace, options.resources ?? {}, inputFiles);
      await persist('turn.input', { id: turn.id, input: text });
      const native = await control.owned(session.run({ id: turn.id, text }, control.signal));
      // Native work is evidence even if observation draining, collection or
      // evaluation fails afterwards. Never make retaining usage depend on them.
      const turnReport: TurnReport = { id: turn.id, native, checks: [] };
      turns.push(turnReport);
      output = native.text;
      coverage = turns.flatMap(prior => prior.native.coverage);
      await persist('turn.native-result', { id: turn.id, native });
      await control.owned(observationTail);
      if (observationFailure) throw new Error(observationFailure);
      const state = await control.owned(snapshot());
      const authored = ('checks' in turn ? turn.checks : undefined) ?? [];
      const checks = authored.length ? (await evaluatePlan([{ id: `turn-${turn.id}`, checks: authored }],
        evaluate({ ...state, closed: true, events: state.events.filter(event => event.wakeId === turn.id),
          coverage: native.coverage }), registry)).stages[0]!.checks : [];
      turnReport.checks = checks;
      await persist('turn.completed', turnReport);
      if (native.status !== 'completed') { execution = native.status === 'cancelled' ? 'interrupted' : 'failed'; error = native.error; break; }
      if (checks.some(check => check.status !== 'pass' || check.finality !== 'final')) { execution = 'interrupted'; error = 'Turn gate is not satisfied'; break; }
      Object.assign(bindings, captureBindings(('bind' in turn ? turn.bind : undefined) ?? {},
        { events: state.events.filter(event => event.wakeId === turn.id), context: state.context }));
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    const abortedByPolicy = control.cause === 'decisive' && caught instanceof Error && caught.name === 'AbortError';
    execution = control.cause === 'operator' || control.cause === 'deadline' || abortedByPolicy ? 'interrupted' : 'failed';
    control.stop(error);
  }
  if (control.signal.aborted && execution === 'completed') execution = 'interrupted';
  control.closeNative('Native trial work ended');
  await control.receipt();
  try {
    await control.owned(drainObservations(() => observationTail));
    if (observationFailure) throw new Error(observationFailure);
  } catch (caught) {
    error = `Observation closure failed: ${String(caught)}`; execution = 'failed'; control.stop(error);
  }
  closed = true;
  try {
    let finalSnapshot: EvaluationSnapshot;
    let evaluation: TrialReport['evaluation'] = { status: 'error', stages: [], checks: {}, scores: {} };
    let liveGates: EvaluationResult[] = [];
    try { finalSnapshot = await control.owned(snapshot()); }
    catch (caught) {
      error = `Final collection failed: ${String(caught)}`; execution = 'failed'; control.stop(error);
      finalSnapshot = { trialId: options.id, recordId: record.id, closed, events: structuredClone(events),
        coverage: structuredClone(coverage), output, inputFiles: { ...inputFiles }, context: record.context ?? {}, artifacts: {} };
    }
    try {
      liveGates = await control.owned(live.close(finalSnapshot, !live.decisive));
      if (live.decisive) {
        evaluation = { status: 'skipped', stages: [], checks: {}, scores: {} };
        await persist('terminal.evaluation.skipped', { reason: 'Selected decisive mechanical failure', witness: live.decisive });
      } else evaluation = await control.owned(evaluatePlan(record.effectiveStages, evaluate(finalSnapshot), registry));
    } catch (caught) {
      error = `Final evaluation failed: ${String(caught)}`; execution = 'failed'; control.stop(error);
    }
    const finalStop = await control.receipt();
    if (control.signal.aborted && execution === 'completed') execution = 'interrupted';
    const gates = [result(evaluation.status, 'Terminal plan'), ...liveGates,
      ...(live.decisive ? [live.decisive] : []), ...turns.flatMap(turn => turn.checks)];
    if (execution !== 'completed' && !live.decisive) gates.push(result('error', error ?? control.reason ?? 'Incomplete native execution'));
    const report: TrialReport = { schema: 'paideia.trial.v1', id: options.id, phase: options.phase,
      candidateId: options.candidateId, datasetDigest: options.datasetDigest, planDigest: options.planDigest,
      recordId: record.id, paths, status: combine('all', gates).status, execution, hostWork: control.hostWork, snapshot: finalSnapshot,
      turns, evaluation, live: structuredClone(live.history), decisiveFailure: structuredClone(live.decisive),
      stop: structuredClone(finalStop), ...(error ? { error } : {}) };
    if (sinkFailed) throw new Error('Trial evidence persistence failed; no durable success report');
    await persist('trial.completed', report);
    return report;
  } finally { control.dispose(); }
}
