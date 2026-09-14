import type { StopReceipt } from '../../../contracts/execution.js';

export type NativeWorkerPath = '/trial/health' | '/trial/run' | '/trial/stop' | '/v2/activity';
export type NativeWorkerRequest = <T>(path: NativeWorkerPath, body?: unknown, timeoutMs?: number, signal?: AbortSignal) => Promise<T>;
export interface NativeExecutionHandle {
  name: string;
  request: NativeWorkerRequest;
  stop(reason: string): Promise<StopReceipt>;
}

