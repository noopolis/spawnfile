import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import type { StopReceipt, StopUnconfirmed, SubjectStartupDiagnostic, TerminalEvidenceMissing } from '../../../contracts/execution.js';
import { isGrokLaunch, nativeTrialArtifactsRoot, readPrivateFile, type VerifiedNativeLaunch } from '../receipt/index.js';
import { admittedExecutions, declaredLimitStop, executionClosed, validateNativeFrame, AMBIGUOUS_NATIVE_EXECUTION, type NativeActivity, type NativeStopEvidence,
  type TerminalEvidence } from '../worker/index.js';
import { createNativeHttpClient, transportTerminalBinding, type NativeExecutionHandle } from '../transport/index.js';
import { engineWakeTimeoutMs, parseTransportSource, type TransportDeliverySource } from '../worker/index.js';
import { ensureNativeTrialArtifacts, nativeChildArguments, nativeChildEnvironment, validateChildPaths } from './arguments.js';
import { verifyChildSandbox } from './sandbox.js';
import type { NativeChildExecution } from './types.js';
import type { GrokSlotFreshnessStore } from './slot-freshness.js';
import { childDiagnostics } from './diagnostics.js';

/** One fresh worker process in the caller's existing container; no Docker or remote proof. */
export async function startOwnedChild(execution: NativeChildExecution, launch: VerifiedNativeLaunch, trialId: string,
  timeoutMs: number, signal?: AbortSignal, startupMs = 60_000, protectedPaths: readonly string[] = []): Promise<NativeExecutionHandle> {
  if (!Number.isSafeInteger(startupMs) || startupMs < 1 || startupMs > 3_600_000) throw new Error('Invalid native startup deadline');
  signal?.throwIfAborted();
  const startup = new AbortController();
  const abort = () => startup.abort(); signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.min(startupMs, timeoutMs));
  try {
    if (execution.prepare) await bounded(execution.prepare({ launch: structuredClone(launch), trialId, signal: startup.signal }), startup.signal);
    startup.signal.throwIfAborted();
    await validateChildPaths(launch);
    await ensureNativeTrialArtifacts(launch, trialId);
    const env = await nativeChildEnvironment(launch);
    const token = (await readPrivateFile(launch.tokenFile, 4096)).trim();
    return await launchChild(launch, trialId, timeoutMs, env, token, startup.signal, protectedPaths, execution.grokSlots);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

/**
 * Every value a captured stream must never publish: the control token and every
 * declared environment value (locale and path variables excepted, which are not
 * secret and are useful in a diagnostic), plus the credential file paths.
 */
function childSecrets(launch: VerifiedNativeLaunch, env: NodeJS.ProcessEnv, token: string): string[] {
  const safe = new Set(['HOME', 'PATH', 'LANG', 'LC_ALL', 'TZ']);
  return [token, launch.tokenFile, launch.envFile,
    ...Object.entries(env).filter(([key]) => !safe.has(key)).map(([, value]) => value ?? '')].filter(Boolean);
}

async function launchChild(launch: VerifiedNativeLaunch, trialId: string, timeoutMs: number, env: NodeJS.ProcessEnv,
  token: string, startup: AbortSignal, protectedPaths: readonly string[], grokSlots?: GrokSlotFreshnessStore): Promise<NativeExecutionHandle> {
  const http = createNativeHttpClient(`http://${launch.host.bindHost}:${launch.host.port}`, token, launch.delivery);
  const diagnostics = await childDiagnostics(nativeTrialArtifactsRoot(launch, trialId), trialId, launch.configSha256,
    childSecrets(launch, env, token));
  const group = process.platform !== 'win32';
  const child = spawn(process.execPath, nativeChildArguments(launch, trialId, timeoutMs), {
    cwd: dirname(launch.workerRoot), env, detached: group, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pid = child.pid;
  let reaped = false;
  let exited = false; let exitCode: number | null = null; let exitSignal: NodeJS.Signals | null = null; let ready = false; let failure = false; let buffer = ''; let bytes = 0;
  child.once('error', () => { failure = true; });
  child.once('exit', () => { reaped = true; });
  child.once('close', (code, signal) => { exited = true; exitCode = code; exitSignal = signal; });
  const groupGone = (): boolean => {
    // Only ESRCH proves absence. Unsupported inspection and EPERM stay unknown.
    if (!group || pid === undefined) return false;
    try { process.kill(-pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  };
  const send = (signal: NodeJS.Signals): void => {
    // Reaping ends signaling authority: a retained numeric PID/PGID can be reused.
    if (pid === undefined || reaped) return;
    try { process.kill(group ? -pid : pid, signal); } catch { /* Closure observation decides, never signal success. */ }
  };
  const consume = (chunk: Buffer, stdout: boolean) => {
    diagnostics.append(chunk, stdout);
    bytes += chunk.length;
    if (bytes > 1_048_576) { failure = true; send('SIGTERM'); return; }
    if (!stdout) return;
    buffer += chunk.toString('utf8');
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (row.schema === 'paideia.daimon-native.ready.v1' && row.trialId === trialId && row.configSha256 === launch.configSha256 &&
          row.agentId === launch.agent.id && row.model === launch.agent.model && row.port === launch.host.port &&
          (!isGrokLaunch(launch) || row.engine === 'grok' && row.reasoningEffort === launch.agent.reasoningEffort)) ready = true;
      } catch { /* Bootstrap may emit non-protocol logging; never treat it as readiness. */ }
    }
  };
  child.stdout.on('data', (chunk: Buffer) => consume(chunk, true)); child.stderr.on('data', (chunk: Buffer) => consume(chunk, false));
  let stopping: Promise<StopReceipt> | undefined;
  /**
   * One entry per delivery this trial made, in order: which wake it was, and why
   * that wake's own frame cannot be scored from. `terminal-absent` is no frame at
   * all for that delivery; `terminal-unbound` is a frame whose identity, closed
   * trace or resolved execution disagreed, including one belonging to another
   * trial; `terminal-ambiguous` is a frame whose named execution has more than
   * one closed trace answering to it. Kept apart rather than collapsed, because
   * they call for fixes in different places.
   *
   * A ledger rather than one verdict, because a trial whose subject defers runs
   * several wakes and each one publishes its own frame. Holding only the newest
   * meant a continuation that did not bind erased the account of a wake that HAD
   * bound, over a closed trace, on a runtime the same stop proves quiet — and the
   * trial then reported that it had no terminal evidence at all, which was false.
   */
  const wakes: WakeEvidence[] = [];
  /**
   * A fault that belongs to the TRIAL rather than to one of its wakes, and which
   * therefore no other wake's frame may be scored past.
   *
   * Isolation is the property: a frame from another trial, agent, model, config
   * or delivery, a foreign execution among the traces, or one execution answering
   * to two closed traces all say that what this runtime published cannot be
   * attributed, and attribution is exactly what selection would be doing. A wake
   * that simply named no closed execution of its own is the other kind — that
   * wake is unscorable and the trial's earlier frames are untouched.
   */
  let sealed: TerminalEvidenceMissing | undefined;
  let diagnosed: SubjectStartupDiagnostic | undefined;
  /**
   * Closure is one question — is anything still running or still spending? — and
   * it is the conjunction of four independent live proofs: the runtime admits no
   * execution of this agent's, it sealed and acknowledged its own stop, and the
   * owned child exited cleanly, and its process group disappeared (decided below,
   * after the kill escalation). Escaped descendants and remote work stay unknown.
   *
   * It used to demand a fourth: that the last delivery's terminal frame bind to a
   * resolved execution. That was interrogating another service's inbox
   * bookkeeping over HTTP — a fact about the last delivery's paperwork, derived
   * from a snapshot the runtime had already published, which cannot say whether
   * anything is spending NOW. Everything it could claim comes from the same
   * runtime that answers `/v2/activity` live, so it added no authority while it
   * did subtract scorable runs: across seven investigations this predicate failed
   * a different way each time on a run that was healthy. The binding still
   * happens and still rejects a foreign trial's frame; it reports as missing
   * EVIDENCE instead.
   *
   * Each proof names itself on the receipt, which publishes durably with the
   * turn, because the evidence that would identify a missing one lives in the
   * worker's control root and a training slot puts that on tmpfs. The vocabulary
   * is closed, so nothing here can leak a path, a token, a body or an error
   * string.
   */
  const proveClosure = async (): Promise<StopUnconfirmed | undefined> => {
    if (!ready || exited) return 'worker-unavailable';
    // Read before the stop, so the query is answered by the runtime that owns the
    // execution; a host the worker already stopped seals this projection instead.
    let activity: NativeActivity;
    try { activity = await http<NativeActivity>('/v2/activity', undefined, 1500); }
    catch { return 'activity-unreadable'; }
    // Requested even when the projection already refuses closure: a runtime that
    // can still be told to stop should be, and the cause below names the busier
    // fault first rather than whichever one this request happens to return.
    let native: NativeStopEvidence | undefined;
    try { native = await http<NativeStopEvidence>('/trial/stop', {}, 6000); } catch { native = undefined; }
    // A projection with no execution authority, or carrying another agent's
    // execution, cannot be counted at all; an unfinished runtime answers with the
    // execution it is still running. Different faults, different names.
    let admitted: number;
    try { admitted = admittedExecutions(activity, launch.agent.id); }
    catch { return 'execution-unbound'; }
    if (admitted > 0) return 'activity-busy';
    if (native?.state !== 'acknowledged') return 'native-stop-unacknowledged';
    return undefined;
  };
  const stop = (reason: string): Promise<StopReceipt> => stopping ??= (async () => {
    // The trial's own evidence, selected rather than taken from whichever delivery
    // answered last: the most recent wake that bound is the most recent account of
    // this trial, and it is named so a scored report can say which wake it read. A
    // trial-wide fault outranks every frame, and with no admissible wake at all the
    // refusal keeps the last delivery's own cause.
    const scored = sealed ? undefined : [...wakes].reverse().find(entry => entry.unevidenced === undefined);
    const last = wakes[wakes.length - 1];
    const evidence = scored ? undefined : sealed ?? last?.unevidenced ?? 'terminal-absent';
    let cause: StopUnconfirmed | undefined;
    try { cause = await proveClosure(); }
    catch { cause = 'activity-unreadable'; /* Uncertain native work requires outer-container termination. */ }
    if (!exited) send('SIGTERM');
    const until = Date.now() + 2000;
    while ((!exited || !groupGone()) && Date.now() < until) await pause(20);
    if (!exited || !groupGone()) {
      send('SIGKILL');
      const forced = Date.now() + 1000;
      while ((!exited || !groupGone()) && Date.now() < forced) await pause(20);
    }
    await diagnostics.save(exitCode, exitSignal);
    cause ??= !exited || !groupGone() ? 'child-running' : exitCode === 0 ? undefined : 'child-exit';
    const confirmed = cause === undefined;
    // A worker that died mid-turn published nothing: startup owns the only
    // other route this record takes, and the protected file it is built from
    // lives on a slot tmpfs that dies with the container. Build it here so the
    // durable event stream carries why the worker stopped answering — for a
    // frame that never arrived as much as for an unproven closure, since its
    // last words are exactly what explains a missing one.
    if (!confirmed || evidence) { try { diagnosed = diagnostics.record(new Error(reason)); } catch { /* never fails a stop */ } }
    return { state: confirmed ? 'acknowledged' : 'unknown', scope: 'native-handle', quiescence: confirmed ? 'confirmed' : 'unknown', remoteWork: 'unknown', reason,
      ...(cause ? { unconfirmed: cause } : {}),
      // Two separate questions, two separate names: a run can be provably quiet
      // AND unscorable, and a report that cannot say which one it is sends the
      // next investigation to the wrong layer.
      ...(evidence ? { unevidenced: evidence } : {}),
      // Which wake the verdict rests on, and every wake's own verdict beside it.
      // Selection must not become suppression: a continuation that did not bind is
      // a real account of that wake, and it travels here because the worker's own
      // per-wake files live on a control root a training slot puts on tmpfs.
      ...(scored ? { evidenced: scored.wakeId } : {}),
      ...(wakes.length ? { wakes: wakes.map(entry => ({ wakeId: entry.wakeId, ...(entry.unevidenced ? { unevidenced: entry.unevidenced } : {}) })) } : {}),
      detail: !confirmed ? `Native child closure unconfirmed (${cause}); caller must stop the shared container`
        : evidence ? `Idle native runtime, acknowledged native stop, worker exit and process group gone; no terminal evidence to score this trial (${evidence})${last ? ` on wake ${last.wakeId}` : ''}`
          : `Closed native execution, idle runtime, acknowledged native stop, worker exit and process group gone${scored === last ? '' : `; scored from wake ${scored!.wakeId}, not wake ${last!.wakeId} (${last!.unevidenced})`}` };
  })();
  try {
    while (!ready) {
      startup.throwIfAborted();
      if (failure || exited) throw new Error('Native worker exited or failed before readiness');
      await pause(20);
    }
    const health = await http<{ version: string; state: string; agents: { agentId: string }[] }>('/trial/health', undefined, 1000, startup);
    if (health.version !== 'noopolis.daimon.organization-runtime-health.v1' || health.state !== 'running' || health.agents.length !== 1 || health.agents[0]?.agentId !== launch.agent.id) throw new Error('Native worker readiness identity mismatch');
    await verifyChildSandbox(launch, trialId, protectedPaths, startup, grokSlots);
    startup.throwIfAborted();
    const request: NativeExecutionHandle['request'] = async <T>(path: Parameters<NativeExecutionHandle['request']>[0], body?: unknown, ms?: number, signal?: AbortSignal) => {
      if (failure || exited) throw new Error('Owned native worker is no longer alive');
      // Recorded before the call, so a delivery whose frame never arrives is still
      // this trial's own wake with its own cause rather than a gap in the ledger.
      const wake = path !== '/trial/run' || body === undefined ? undefined : named((body as { wakeId?: unknown })?.wakeId);
      if (wake && launch.delivery === 'transport') wake.source = parseTransportSource((body as { source?: unknown }).source);
      if (wake) wakes.push(wake);
      const result = await http<T>(path, body, ms, signal);
      if (wake) bindTerminalEvidence(wake, result as TerminalEvidence, launch, trialId, fault => { sealed ??= fault; }, engineWakeTimeoutMs(timeoutMs, launch));
      return result;
    };
    return { name: `child:${child.pid}`, request, stop, diagnostic: () => diagnosed };
  } catch (error) {
    // The protected capture lives on the control root, which a training slot puts on tmpfs; the thrown
    // carrier holds the redacted record so the caller can persist the failure class durably.
    await stop('Native child startup failed');
    throw diagnostics.startupFailure(error);
  }
}

/** One delivery's place in the ledger: which wake it was, and why its frame cannot be scored. */
interface WakeEvidence { wakeId: string; source?: TransportDeliverySource; unevidenced?: TerminalEvidenceMissing }

/**
 * The delivery's own wake name, at the bound the worker's gate admits.
 *
 * The receipt publishes durably and its vocabulary is closed, so the name a
 * caller passed is either one of those bounded identifiers or it is not
 * published at all: `unnamed` is a statement about the ledger entry, never a
 * path, a token or a body smuggled onto the record by a caller's own string.
 */
const WAKE_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
function named(wakeId: unknown): WakeEvidence {
  return { wakeId: typeof wakeId === 'string' && WAKE_NAME.test(wakeId) ? wakeId : 'unnamed', unevidenced: 'terminal-absent' };
}

/**
 * Whether ONE wake's frame can be scored from — never whether something is still
 * spending, and never a verdict about the trial around it.
 *
 * A frame from another trial, agent, wake or config is not this trial's evidence,
 * and that check lives here rather than in the closure predicate. The receipt has
 * to name this trial's own delivery too: the frame's identity and the delivery the
 * runtime answered for are one delivery, or the frame is accounting for somebody
 * else's wake. Those are attribution failures, so they `seal` the whole trial:
 * nothing this runtime published can be scored past one.
 *
 * A trial whose subject deferred runs its continuations as further wakes, and each
 * one closes an execution of its own. The trace that answers for THIS frame is the
 * one the frame names; the rest are this same trial's earlier, already-closed
 * wakes, and counting them was refusing a healthy run for the arity of its own
 * history. Nothing is admitted by position: an unnamed execution resolves to no
 * trace at all, and that is this wake's own fault rather than the trial's.
 *
 * An identity conflict still throws, because it must fail the turn rather than
 * pass as verified work; it only records what it was first. Two traces answering
 * to the named execution is its own word: the frame is not unbound, it is
 * unreadable, and that distinction is what sends the next look at it upstream
 * instead of here.
 */
export function bindTerminalEvidence(wake: WakeEvidence, value: TerminalEvidence, launch: VerifiedNativeLaunch, trialId: string,
  seal: (fault: TerminalEvidenceMissing) => void, wakeTimeoutMs?: number): void {
  const own = value.schema === 'paideia.daimon-native.trial.v1' && value.trialId === trialId && value.agentId === launch.agent.id &&
    value.model === launch.agent.model && value.configSha256 === launch.configSha256 &&
    value.wakeId === wake.wakeId;
  const binding = launch.delivery === 'transport' ? transportTerminalBinding(value, wake.source)
    : value.receipt && value.activity && value.receipt.agent_id === launch.agent.id &&
      value.receipt.delivery_id === `${trialId}:${value.wakeId}` ? 'bound' : 'conflict';
  wake.unevidenced = 'terminal-unbound';
  if (!own || binding === 'conflict') { seal('terminal-unbound'); return; }
  try {
    if (binding === 'incomplete') {
      if (value.activity) admittedExecutions(value.activity, launch.agent.id);
      const ids = new Set<string>();
      for (const trace of value.native.traces) {
        if (trace.agent_id !== launch.agent.id) throw new Error('Native execution evidence identity mismatch');
        if (ids.has(trace.turn_id)) throw new Error(AMBIGUOUS_NATIVE_EXECUTION);
        ids.add(trace.turn_id);
      }
      return;
    }
    validateNativeFrame(value.activity!, value.receipt!, value.native.traces, launch.agent.id, value.executionId);
    const trace = typeof value.executionId === 'string' ? value.native.traces.find(row => row.turn_id === value.executionId) : undefined;
    // A failed trace binds only as the declared-limit stop the worker labelled and
    // its own sealed usage row still states; any other failure stays unscorable.
    const limited = value.limit !== undefined && declaredLimitStop(trace, value.native.usage, wakeTimeoutMs) === value.limit;
    if (!trace || trace.status !== 'completed' && !limited) return;
    if (executionClosed(value.activity!, value.receipt!, value.native.traces, launch.agent.id, trace.turn_id) === value.executionId) wake.unevidenced = undefined;
  } catch (conflict) {
    const fault = (conflict as Error).message === AMBIGUOUS_NATIVE_EXECUTION ? 'terminal-ambiguous' : 'terminal-unbound';
    wake.unevidenced = fault;
    seal(fault);
    throw conflict;
  }
}

async function bounded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new Error('Native child preparation cancelled')); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([pending, cancelled]); } finally { signal.removeEventListener('abort', abort); }
}
