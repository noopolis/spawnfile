import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { StopReceipt } from '../../contracts/execution.js';

export interface ProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onLine: (line: string, signal: AbortSignal) => void | Promise<void>;
  maxBytes?: number;
  keepStdinOpen?: boolean;
  /** Opt-in multiplexing; native observation streams remain ordered by default. */
  callbackConcurrency?: number;
  closureDrainMs?: number;
  requireLineTerminator?: boolean;
}

export interface ProcessResult {
  exitCode: number | null;
  error?: string;
  stderr: string;
  cancelled: boolean;
  stop?: StopReceipt;
}

export interface RunningProcess {
  completion: Promise<ProcessResult>;
  stop(reason: string): Promise<StopReceipt>;
  write(data: string): Promise<void>;
  endInput(): void;
}

/** Runs a pinned protocol without a shell; callback failure stops the native process. */
export function runProcess(options: ProcessOptions): RunningProcess {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('Process timeout must be positive');
  }
  const concurrency = options.callbackConcurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Callback concurrency must be 1..8');
  const group = process.platform !== 'win32';
  const child = spawn(options.command, options.args, {
    cwd: options.cwd, env: options.env, detached: group, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pid = child.pid;
  let closed = false;
  let reaped = false;
  let cancelled = false;
  let failure: string | undefined;
  let receipt: StopReceipt | undefined;
  let stopping: Promise<StopReceipt> | undefined;
  let stderr = '';
  let pending = '';
  let bytes = 0;
  const queue: string[] = [];
  const callbacks = new Set<Promise<void>>();
  const callbackController = new AbortController();
  const exists = (): boolean => {
    if (pid === undefined) return false;
    if (!group) return !closed;
    try { process.kill(-pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  };
  const send = (signal: NodeJS.Signals): void => {
    // Once reaped, a retained numeric PID/PGID is not stable process identity.
    if (pid === undefined || reaped) return;
    try { process.kill(group ? -pid : pid, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = 'Unable to signal owned process';
    }
  };
  const stop = (reason: string): Promise<StopReceipt> => {
    stopping ??= (async () => {
      cancelled = true;
      callbackController.abort(new Error(reason));
      send('SIGTERM');
      const deadline = Date.now() + 1_500;
      while (exists() && Date.now() < deadline) {
        if (Date.now() > deadline - 1_200) send('SIGKILL');
        await delay(20);
      }
      const remaining = exists();
      receipt = {
        state: remaining ? 'unknown' : 'acknowledged',
        scope: group ? 'process-group' : 'process',
        quiescence: remaining ? 'unknown' : 'confirmed',
        remoteWork: 'unknown', reason,
        detail: 'No signals are sent after the native leader is reaped. Remaining group ownership, escaped descendants and remote effects may be unknown.',
      };
      if (receipt.quiescence === 'unknown') {
        child.stdout.destroy();
        child.stderr.destroy();
      }
      return receipt;
    })();
    return stopping;
  };
  const rejectProtocol = (error: unknown): void => {
    failure = error instanceof Error ? error.message : String(error);
    void stop('observation or output failure');
  };
  const enqueue = (line: string): void => {
    if (line.trim().length > 0) queue.push(line);
    dispatch();
  };
  const dispatch = (): void => {
    if (failure !== undefined || callbackController.signal.aborted) { queue.length = 0; return; }
    while (queue.length > 0 && callbacks.size < concurrency) {
      const line = queue.shift()!;
      const callback = Promise.resolve().then(() => {
        if (failure === undefined && !callbackController.signal.aborted) return deliver(line);
      }).catch(rejectProtocol).finally(() => { callbacks.delete(callback); dispatch(); });
      callbacks.add(callback);
    }
  };
  const drainCallbacks = async (): Promise<void> => {
    // Finishing callbacks may start queued work; a snapshot alone misses it.
    while (callbacks.size > 0) await Promise.all([...callbacks]);
  };
  const deliver = async (line: string): Promise<void> => {
    const callback = new AbortController();
    const abort = () => callback.abort(callbackController.signal.reason);
    callbackController.signal.addEventListener('abort', abort, { once: true });
    if (callbackController.signal.aborted) abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      cancel = () => { timer = setTimeout(() => reject(new Error('Observation callback did not settle after cancellation')), 100); };
      callback.signal.addEventListener('abort', cancel, { once: true });
      if (callback.signal.aborted) cancel();
    });
    try { await Promise.race([Promise.resolve(options.onLine(line, callback.signal)), interrupted]); }
    finally { clearTimeout(timer); callback.signal.removeEventListener('abort', cancel);
      callbackController.signal.removeEventListener('abort', abort); }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > (options.maxBytes ?? 16 * 1024 * 1024)) {
      rejectProtocol(new Error('Native output exceeded its byte limit'));
      return;
    }
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) enqueue(line);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-65_536); });
  child.stdin.on('error', () => { /* Native terminal status decides a closed stdin. */ });
  child.stdin.write(options.stdin);
  if (options.keepStdinOpen !== true) child.stdin.end();
  const onAbort = (): void => { void stop('abort signal'); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted === true) onAbort();
  const timer = setTimeout(() => { failure = 'Native process timed out'; void stop('timeout'); }, options.timeoutMs);
  const completion = new Promise<ProcessResult>((resolve) => {
    child.once('error', (error) => { failure = error.message; });
    child.once('exit', () => { reaped = true; });
    child.once('close', (exitCode) => {
      closed = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (options.requireLineTerminator === true && pending.length > 0) {
        rejectProtocol(new Error('Native protocol ended without a line terminator'));
      } else enqueue(pending);
      const drain = setTimeout(() => callbackController.abort(new Error('Native process closed')),
        options.closureDrainMs ?? 2_000);
      void drainCallbacks().then(async () => {
        clearTimeout(drain);
        callbackController.abort(new Error('Native process closed'));
        if (stopping !== undefined) await stopping;
        resolve({ exitCode, error: failure, stderr, cancelled, stop: receipt });
      });
    });
  });
  return { completion, stop,
    write: (data) => new Promise<void>((resolve, reject) => {
      if (closed || child.stdin.writableEnded) { reject(new Error('Native process input is closed')); return; }
      child.stdin.write(data, (error) => { if (error !== null && error !== undefined) reject(error); else resolve(); });
    }),
    endInput: () => { child.stdin.end(); },
  };
}
