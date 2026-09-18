import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import type { StopReceipt, StopUnconfirmed, SubjectStartupDiagnostic, TerminalEvidenceMissing } from '../../../contracts/execution.js';
import { isGrokLaunch, nativeTrialArtifactsRoot, readPrivateFile, type VerifiedNativeLaunch } from '../receipt/index.js';
import { admittedExecutions, executionClosed, type NativeActivity, type NativeStopEvidence, type TerminalEvidence } from '../worker/index.js';
import { createNativeHttpClient, type NativeExecutionHandle } from '../transport/index.js';
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
  const http = createNativeHttpClient(`http://${launch.host.bindHost}:${launch.host.port}`, token);
  const diagnostics = await childDiagnostics(nativeTrialArtifactsRoot(launch, trialId), trialId, launch.configSha256,
    childSecrets(launch, env, token));
  const child = spawn(process.execPath, nativeChildArguments(launch, trialId, timeoutMs), {
    cwd: dirname(launch.workerRoot), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited = false; let exitCode: number | null = null; let exitSignal: NodeJS.Signals | null = null; let ready = false; let failure = false; let buffer = ''; let bytes = 0;
  child.once('error', () => { failure = true; });
  child.once('close', (code, signal) => { exited = true; exitCode = code; exitSignal = signal; });
  const consume = (chunk: Buffer, stdout: boolean) => {
    diagnostics.append(chunk, stdout);
    bytes += chunk.length;
    if (bytes > 1_048_576) { failure = true; child.kill('SIGTERM'); return; }
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
   * Why this trial has no terminal evidence to be scored from — never a closure
   * cause. `terminal-absent` is no frame at all for the last delivery;
   * `terminal-unbound` is a frame whose identity, closed trace or resolved
   * execution disagreed, including one belonging to another trial. Kept apart
   * rather than collapsed, because they call for fixes in different places.
   */
  let evidence: TerminalEvidenceMissing | undefined = 'terminal-absent';
  let diagnosed: SubjectStartupDiagnostic | undefined;
  /**
   * Closure is one question — is anything still running or still spending? — and
   * it is the conjunction of three independent live proofs: the runtime admits no
   * execution of this agent's, it sealed and acknowledged its own stop, and the
   * owned child exited (decided below, after the kill escalation).
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
    let cause: StopUnconfirmed | undefined;
    try { cause = await proveClosure(); }
    catch { cause = 'activity-unreadable'; /* Uncertain native work requires outer-container termination. */ }
    if (!exited) child.kill('SIGTERM');
    const until = Date.now() + 2000;
    while (!exited && Date.now() < until) await pause(20);
    if (!exited) { child.kill('SIGKILL'); const forced = Date.now() + 1000; while (!exited && Date.now() < forced) await pause(20); }
    await diagnostics.save(exitCode, exitSignal);
    cause ??= !exited ? 'child-running' : exitCode === 0 ? undefined : 'child-exit';
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
      detail: !confirmed ? `Native child closure unconfirmed (${cause}); caller must stop the shared container`
        : evidence ? `Idle native runtime, acknowledged native stop and worker exit; no terminal evidence to score this trial (${evidence})`
          : 'Closed native execution, idle runtime, acknowledged native stop and worker exit' };
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
      if (path === '/trial/run') evidence = 'terminal-absent';
      const result = await http<T>(path, body, ms, signal);
      if (path === '/trial/run') {
        const value = result as TerminalEvidence;
        // Whether this trial can be SCORED — never whether something is still
        // spending. A frame from another trial, agent, wake or config is not this
        // trial's evidence, and that check moved here rather than disappearing.
        const bound = value.schema === 'paideia.daimon-native.trial.v1' && value.trialId === trialId && value.agentId === launch.agent.id &&
          value.model === launch.agent.model && value.configSha256 === launch.configSha256 &&
          value.wakeId === (body as { wakeId?: string })?.wakeId && !!value.receipt && !!value.activity;
        evidence = !bound || value.native.traces[0]?.status !== 'completed' ? 'terminal-unbound' : undefined;
        if (evidence === undefined) {
          // An identity conflict still throws, because it must fail the turn rather
          // than pass as verified work; it only records what it was first.
          evidence = 'terminal-unbound';
          if (executionClosed(value.activity!, value.receipt!, value.native.traces, launch.agent.id) === value.executionId) evidence = undefined;
        }
      }
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

async function bounded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new Error('Native child preparation cancelled')); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([pending, cancelled]); } finally { signal.removeEventListener('abort', abort); }
}
