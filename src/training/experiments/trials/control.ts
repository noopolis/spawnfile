import type { StopReceipt, SubjectSession } from '../../contracts/execution.js';

export function trialControl(timeoutMs: number, outer?: AbortSignal) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Trial timeout must be a positive integer');
  const controller = new AbortController();
  let session: SubjectSession | undefined;
  let stopping: Promise<StopReceipt> | undefined;
  let closingReason: string | undefined;
  let reason: string | undefined;
  let cause: 'operator' | 'deadline' | 'requested' | 'decisive' | undefined;
  let pending = 0;
  const unknown = (detail: string): StopReceipt => ({ state: 'unknown', scope: 'native-handle', quiescence: 'unknown',
    remoteWork: 'unknown', reason: reason ?? closingReason!, detail });
  const closeNative = (why: string) => {
    closingReason ??= why;
    if (session && !stopping) stopping = Promise.resolve().then(() => session!.stop(closingReason!)).catch(error => unknown(String(error)));
  };
  const stop = (why: string, source: 'operator' | 'deadline' | 'requested' | 'decisive' = 'requested') => {
    reason ??= why;
    // External cancellation outranks internal failures, including during finalization.
    if (!cause || (source === 'operator' || source === 'deadline') && cause !== 'operator' && cause !== 'deadline') {
      reason = why; cause = source;
    }
    controller.abort(new DOMException(reason, 'AbortError'));
    closeNative(reason);
  };
  const external = () => stop('Operator cancelled', 'operator');
  if (outer?.aborted) external();
  outer?.addEventListener('abort', external, { once: true });
  const timer = setTimeout(() => stop('Trial deadline exceeded', 'deadline'), timeoutMs);
  return {
    signal: controller.signal, stop, closeNative,
    get reason() { return reason; },
    get cause() { return cause; },
    get hostWork(): 'settled' | 'incomplete' { return pending ? 'incomplete' : 'settled'; },
    attach(value: SubjectSession) { session = value; if (closingReason) closeNative(closingReason); },
    async receipt(): Promise<StopReceipt | undefined> {
      if (!stopping) return closingReason ? unknown('Native handle is unavailable for stop acknowledgement') : undefined;
      let drain: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([stopping,
        new Promise<StopReceipt>(resolve => { drain = setTimeout(() => resolve(unknown('Stop acknowledgement deadline exceeded')), 2_000); })]); }
      finally { clearTimeout(drain); }
    },
    async owned<T>(work: Promise<T>): Promise<T> {
      pending++;
      void work.finally(() => { pending--; }).catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: () => void = () => {};
      const interrupted = new Promise<never>((_, reject) => {
        abort = () => { timer = setTimeout(() => reject(new Error('Owned work did not settle after cancellation')), 2_000); };
        controller.signal.addEventListener('abort', abort, { once: true });
        if (controller.signal.aborted) abort();
      });
      try { return await Promise.race([work, interrupted]); }
      finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
    },
    dispose() { clearTimeout(timer); outer?.removeEventListener('abort', external); },
  };
}
