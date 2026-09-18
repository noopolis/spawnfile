import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import type { StopReceipt, StopUnconfirmed, SubjectStartupDiagnostic } from '../../../contracts/execution.js';
import { isGrokLaunch, nativeTrialArtifactsRoot, readPrivateFile, type VerifiedNativeLaunch } from '../receipt/index.js';
import { executionClosed, type NativeActivity, type NativeStopEvidence, type TerminalEvidence } from '../worker/index.js';
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
  let closed: TerminalEvidence | undefined; let stopping: Promise<StopReceipt> | undefined;
  // Why the last delivery's frame did not bind, kept rather than collapsed into its
  // absence: "no closed evidence" is three different faults calling for three
  // different fixes, and the live run's was the one nobody predicted — a frame that
  // bound perfectly for a delivery the runtime had reclaimed without disposing of it.
  let binding: StopUnconfirmed | undefined = 'terminal-absent';
  let unconfirmed: SubjectStartupDiagnostic | undefined;
  /**
   * Closure is a conjunction of independent proofs, and every one of them can
   * fail on a live run for a different reason that calls for a different fix.
   * They used to share one bare `catch` and one fixed sentence, so an unscorable
   * trial said only "unconfirmed": the evidence that would name the missing
   * proof lived in the worker's control root, which a training slot puts on
   * tmpfs that dies with the container. Each proof now names itself in the
   * receipt, which is published durably with the turn. The verdict is unchanged
   * — every proof is still required — and the vocabulary is closed, so nothing
   * here can leak a path, a token, a body or an upstream error string.
   */
  const proveClosure = async (): Promise<StopUnconfirmed | undefined> => {
    if (!ready || exited) return 'worker-unavailable';
    // Read before the stop, so the query is answered by the runtime that owns the
    // execution; a host the worker already stopped seals this projection instead.
    let activity: NativeActivity;
    try { activity = await http<NativeActivity>('/v2/activity', undefined, 1500); }
    catch { return 'activity-unreadable'; }
    let native: NativeStopEvidence;
    try { native = await http<NativeStopEvidence>('/trial/stop', {}, 6000); }
    catch { return 'native-stop-unacknowledged'; }
    if (!closed?.receipt || !closed.executionId) return binding ?? 'terminal-unbound';
    // An identity conflict throws rather than answering, and an unfinished
    // runtime answers with the execution it is still running; they are different
    // faults and must not share a name.
    let resolved: string | undefined;
    try { resolved = executionClosed(activity, closed.receipt, closed.native.traces, launch.agent.id); }
    catch { return 'execution-unbound'; }
    if (resolved === undefined) return 'activity-busy';
    if (resolved !== closed.executionId) return 'execution-unbound';
    if (native.state !== 'acknowledged') return 'native-stop-unacknowledged';
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
    // durable event stream carries why the worker stopped answering.
    if (!confirmed) { try { unconfirmed = diagnostics.record(new Error(reason)); } catch { /* never fails a stop */ } }
    return { state: confirmed ? 'acknowledged' : 'unknown', scope: 'native-handle', quiescence: confirmed ? 'confirmed' : 'unknown', remoteWork: 'unknown', reason,
      ...(cause ? { unconfirmed: cause } : {}),
      detail: confirmed ? 'Closed native execution, idle runtime, acknowledged native stop and worker exit' : `Native child closure unconfirmed (${cause}); caller must stop the shared container` };
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
      if (path === '/trial/run') { closed = undefined; binding = 'terminal-absent'; }
      const result = await http<T>(path, body, ms, signal);
      if (path === '/trial/run') {
        const value = result as TerminalEvidence;
        const bound = value.schema === 'paideia.daimon-native.trial.v1' && value.trialId === trialId && value.agentId === launch.agent.id &&
          value.model === launch.agent.model && value.configSha256 === launch.configSha256 &&
          value.wakeId === (body as { wakeId?: string })?.wakeId && !!value.receipt && !!value.activity;
        // Closure is "no worker is still spending", and the delivery's DISPOSITION is
        // not one of its proofs. Requiring `completed` or `deferred` here put a
        // scoring fact inside the closure predicate and demoted a scorable turn to an
        // infrastructure failure; the frame being bound, the execution resolving and
        // `executions` being empty already prove the thing this predicate claims. The
        // worker's own path refuses to score an undisposed delivery, loudly and on
        // its own evidence, which is where that judgement belongs.
        binding = !bound || value.native.traces[0]?.status !== 'completed' ? 'terminal-unbound' : undefined;
        if (binding === undefined) {
          // An identity conflict still throws, because it must fail the turn rather
          // than pass as verified work; it only records what it was first.
          binding = 'terminal-unbound';
          if (executionClosed(value.activity!, value.receipt!, value.native.traces, launch.agent.id) === value.executionId) {
            closed = value; binding = undefined;
          }
        }
      }
      return result;
    };
    return { name: `child:${child.pid}`, request, stop, diagnostic: () => unconfirmed };
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
