import { resolve } from 'node:path';
import type { EvaluationSnapshot, EvaluationResult, JudgeAttemptObservation } from '../../contracts/evaluation.js';
import type { Observation, ObservationCoverage } from '../../contracts/execution.js';
import { captureObservation } from '../../capture/index.js';
import { combine, evaluatePlan, mayStop, result } from '../../evaluation/index.js';
import { captureBindings, resolveTurnInput } from './bindings.js';
import { collectOutputs, stageInput } from './files.js';
import { createLiveMonitor } from './live.js';
import { trialControl } from './control.js';
import { requireMechanicalTurn } from './preflight.js';
import { drainObservations } from './closure.js';
import { subjectUsageSnapshot } from './subject-usage.js';
import { createTrialPaths, releaseTrialScratch } from './paths.js';
import { subjectStartupCapture, subjectStartupDiagnostic, writeOperatorCapture } from './diagnostics.js';
import type { PreparedTrial, TrialOptions, TrialReport, TurnReport } from './types.js';

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
  const paths = await createTrialPaths(options.root, options.subjectRoot);
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
  let diagnostic: TrialReport['diagnostic'];
  const inputFiles: Record<string, string> = {};
  const bindings: Record<string, unknown> = {};
  const persist = async (type: string, payload: unknown) => {
    try { await options.persist({ type, payload }); }
    catch (error) { sinkFailed = true; control.stop('Evidence persistence failed'); throw error; }
  };
  const observer = options.evaluation.observeJudgeAttempt;
  const evaluationServices = { ...options.evaluation,
    observeMeasurement: async (measurement: import('../../contracts/evaluation.js').EvaluationMeasurement) => { await persist('evaluation.measurement', measurement); },
    observeJudgeAttempt: async (attempt: JudgeAttemptObservation) => {
    await persist('judge.attempt', attempt);
    await observer?.(structuredClone(attempt));
  } };
  let nativeClosureConfirmed = false;
  const subjectUsage = () => subjectUsageSnapshot(turns.map(turn => turn.native), { expectedTurns: inputs.length,
    complete: closed && execution === 'completed' && control.hostWork === 'settled' && !control.signal.aborted && nativeClosureConfirmed });
  const snapshot = async (): Promise<EvaluationSnapshot> => ({ trialId: options.id, recordId: record.id, closed,
    subjectUsage: subjectUsage(), events: structuredClone(events), coverage: structuredClone(coverage), output, inputFiles: { ...inputFiles }, context: record.context ?? {},
    artifacts: { ...await collectOutputs(record.outputs ?? {}, paths.workspace, `${options.id}/${events.length}`), ...await prepared?.collect?.() } });
  const live = createLiveMonitor({ checks: record.live.checks, registry, evaluation: evaluationServices,
    persist: entry => persist('live.evaluation', entry), stop: why => control.stop(why, 'decisive'), signal: control.signal });
  const evaluate = (state: EvaluationSnapshot) => ({ ...evaluationServices, snapshot: state, results: {}, scores: {}, signal: control.signal });
  try {
    await persist('trial.started', { id: options.id, phase: options.phase, candidateId: options.candidateId,
      datasetDigest: options.datasetDigest, planDigest: options.planDigest, recordId: record.id,
      adapter: adapter.id, capabilities: adapter.capabilities, model: options.model, timeoutMs: options.timeoutMs });
    prepared = await control.owned(options.prepare(paths, control.signal));
    if (control.signal.aborted) throw new Error(control.reason);
    const session = await control.owned(adapter.start({ trialId: options.id, slot: options.slot, workspacePath: paths.workspace,
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
          coverage: native.coverage, subjectUsage: subjectUsageSnapshot([native], { expectedTurns: 1,
            complete: control.hostWork === 'settled' && !control.signal.aborted &&
              native.stop?.state === 'acknowledged' && native.stop.quiescence === 'confirmed' }) }), registry)).stages[0]!.checks : [];
      turnReport.checks = checks;
      await persist('turn.completed', turnReport);
      if (native.status !== 'completed') {
        // A turn that closed its own execution and left the delivery deferred is the
        // subject's outcome, not the machine's. The stop proofs below can still
        // demote it; an uncertain, hung, crashed or cancelled turn never reaches it.
        execution = native.status === 'cancelled' ? 'interrupted'
          : native.blocked === 'awaiting-external-input' ? 'deferred' : 'failed';
        error = native.error; break;
      }
      if (checks.some(check => check.status !== 'pass' || check.finality !== 'final')) { execution = 'interrupted'; error = 'Turn gate is not satisfied'; break; }
      Object.assign(bindings, captureBindings(('bind' in turn ? turn.bind : undefined) ?? {},
        { events: state.events.filter(event => event.wakeId === turn.id), context: state.context }));
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    const abortedByPolicy = control.cause === 'decisive' && caught instanceof Error && caught.name === 'AbortError';
    execution = control.cause === 'operator' || control.cause === 'deadline' || abortedByPolicy ? 'interrupted' : 'failed';
    diagnostic = subjectStartupDiagnostic(caught);
    const capture = diagnostic ? subjectStartupCapture(caught) : undefined;
    // The adapter's own copy can be runtime-local; the operator's trial directory outlives it.
    const operatorCapture = capture ? await writeOperatorCapture(paths.root, capture) : undefined;
    if (diagnostic && operatorCapture) diagnostic = { ...diagnostic, operatorCapture };
    control.stop(error);
  }
  if (diagnostic) {
    // The adapter's full capture can live on storage that dies with its runtime; this is the durable copy.
    // A sink failure is already recorded, and the report below refuses to claim durable success.
    try { await persist('subject.startup-diagnostic', diagnostic); } catch { /* sinkFailed carries it to the report */ }
  }
  if (control.signal.aborted && execution === 'completed') execution = 'interrupted';
  control.closeNative('Native trial work ended');
  const nativeStop = await control.receipt();
  nativeClosureConfirmed = nativeStop?.state === 'acknowledged' && nativeStop.quiescence === 'confirmed';
  // Two separate refusals, and a report that cannot tell them apart sends the next
  // investigation to the wrong layer. Closure is claimable only with the adapter's
  // own proofs — idle runtime, acknowledged stop, observed exit — and without them
  // the run is an unproven execution and stays an infrastructure failure. Terminal
  // evidence is the separate question of whether this trial can be scored at all:
  // a run can be provably quiet and still have no frame to score, which is not a
  // containment doubt and must never be published as one.
  const unproven = !nativeClosureConfirmed ? `Native closure unproven${nativeStop?.unconfirmed ? ` (${nativeStop.unconfirmed})` : ''}` : undefined;
  // A multi-wake trial names the delivery the refusal was read from: with several
  // wakes, "no terminal evidence" alone cannot say which one to go and look at.
  const failedWake = nativeStop?.wakes?.filter(wake => wake.unevidenced).at(-1)?.wakeId;
  const unevidenced = nativeStop?.unevidenced
    ? `Native trial unscorable for want of terminal evidence (${nativeStop.unevidenced})${failedWake ? ` on wake ${failedWake}` : ''}` : undefined;
  if (execution === 'deferred' && (unproven || unevidenced || control.signal.aborted)) {
    execution = 'failed';
    // The deferral is the subject's outcome; this demotion is the machine's. While
    // they shared one message, an unprovable closure published the subject's own
    // "delivery blocked awaiting external input" as the reason a trial was
    // unscorable — the exact sentence that sent two investigations after the
    // subject instead of the missing proof. Name the fault, keep what the turn said.
    error = [...(unproven ? [unproven] : []), ...(unevidenced ? [unevidenced] : []),
      ...(control.signal.aborted ? ['trial cancelled'] : []), ...(error ? [error] : [])].join('; ');
  }
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
      finalSnapshot = { trialId: options.id, recordId: record.id, closed, subjectUsage: subjectUsage(), events: structuredClone(events),
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
    // Subject totals were frozen at native closure; judge failures are separate work.
    if (observationFailure && finalSnapshot.subjectUsage) finalSnapshot.subjectUsage.status = 'incomplete';
    const gates = [result(evaluation.status, 'Terminal plan'), ...liveGates,
      ...(live.decisive ? [live.decisive] : []), ...turns.flatMap(turn => turn.checks)];
    if (execution === 'deferred') {
      // The subject closed its own execution and left the delivery unanswered: a final
      // failing witness in its own right, so the trial is scored and never passes. The
      // measured checks keep their own verdicts and weights — a missing artifact stays
      // missing rather than becoming a zero — and an errored plan still outranks it, so
      // an evaluation that could not measure is never reported as a behavioural zero.
      if (combine('all', gates).status !== 'error') {
        gates.push(result('fail', error ?? 'Native delivery remains deferred awaiting external input'));
      }
    } else if (execution !== 'completed' && !live.decisive) gates.push(result('error', error ?? control.reason ?? 'Incomplete native execution'));
    const report: TrialReport = { schema: 'paideia.trial.v1', id: options.id, phase: options.phase,
      candidateId: options.candidateId, datasetDigest: options.datasetDigest, planDigest: options.planDigest,
      recordId: record.id, paths, status: combine('all', gates).status, execution, hostWork: control.hostWork, snapshot: finalSnapshot,
      expectedTurns: inputs.length, turns, evaluation, live: structuredClone(live.history), decisiveFailure: structuredClone(live.decisive),
      stop: structuredClone(finalStop), ...(diagnostic ? { diagnostic: structuredClone(diagnostic) } : {}), ...(error ? { error } : {}) };
    if (sinkFailed) throw new Error('Trial evidence persistence failed; no durable success report');
    await persist('trial.completed', report);
    return report;
  } finally {
    control.dispose();
    await releaseTrialScratch(paths, options.subjectRoot, nativeClosureConfirmed && control.hostWork === 'settled');
  }
}
