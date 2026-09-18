import type { StopReceipt, SubjectStartupDiagnostic } from '../../../contracts/execution.js';

export type NativeWorkerPath = '/trial/health' | '/trial/run' | '/trial/stop' | '/v2/activity';
export type NativeWorkerRequest = <T>(path: NativeWorkerPath, body?: unknown, timeoutMs?: number, signal?: AbortSignal) => Promise<T>;
export interface NativeExecutionHandle {
  name: string;
  request: NativeWorkerRequest;
  stop(reason: string): Promise<StopReceipt>;
  /**
   * The redacted account of a worker that stopped answering, available once
   * `stop` has settled and only when the closure was not confirmed. A confirmed
   * closure needs no explanation; an unconfirmed one is the case where nothing
   * else says why. Absent for transports that own no child process.
   */
  diagnostic?(): SubjectStartupDiagnostic | undefined;
}

