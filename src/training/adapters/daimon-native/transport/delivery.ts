import { setTimeout as pause } from 'node:timers/promises';
import type { VerifiedNativeLaunch } from '../receipt/index.js';
import { matchTransportSource, parseTransportSource, type TransportDeliverySource, type TerminalEvidence } from '../worker/index.js';
import type { NativeWorkerRequest } from './types.js';

/** The provider reserves a source first; publication happens only after the worker arms it. */
export interface PreparedTransportDelivery {
  source: TransportDeliverySource;
  publish(signal: AbortSignal): Promise<void>;
}
export interface NativeTransportDelivery {
  prepare(context: { trialId: string; turnId: string; text: string; launch: VerifiedNativeLaunch; executionId: string },
    signal: AbortSignal): Promise<PreparedTransportDelivery>;
}

export function verifyPreparedTransport(value: PreparedTransportDelivery, exact = false): void {
  if (!value || Object.keys(value).sort().join(',') !== 'publish,source' || typeof value.publish !== 'function') {
    throw new Error('Invalid prepared transport delivery');
  }
  const source = parseTransportSource(value.source);
  if (exact && !('deliveryId' in source)) throw new Error('Transport continuation requires an exact delivery ID');
}

/** Provider callbacks may not extend the trial's real deadline or outlive cancellation. */
export async function boundedTransportCall<T>(callback: (signal: AbortSignal) => Promise<T>, deadline: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('Transport delivery cancelled');
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Native trial deadline exceeded awaiting transport delivery');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => { controller.abort(); reject(new Error('Transport delivery cancelled')); };
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(new Error('Native trial deadline exceeded awaiting transport delivery')); }, remaining);
  });
  try {
    const value = await Promise.race([callback(controller.signal), interrupted]);
    if (signal.aborted) throw new Error('Transport delivery cancelled');
    return value;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort(); }
}

function sameSource(left: TransportDeliverySource | undefined, right: TransportDeliverySource): boolean {
  return !!left && left.kind === right.kind && ('deliveryId' in left
    ? 'deliveryId' in right && left.deliveryId === right.deliveryId
    : 'deliveryIdPrefix' in right && left.deliveryIdPrefix === right.deliveryIdPrefix);
}

/** A transport receipt binds to its actual delivery, never a synthetic trial/wake key. */
export function transportTerminalBinding(value: TerminalEvidence, source: TransportDeliverySource | undefined): 'bound' | 'incomplete' | 'conflict' {
  const transport = value.transport;
  const incomplete = () => value.status === 'failed' && !value.blocked ? 'incomplete' as const : 'conflict' as const;
  if (!source || !transport || !sameSource(transport.source, source)) return 'conflict';
  if (transport.deliveryId === undefined) return value.receipt || value.executionId || transport.acceptanceId || transport.batch ? 'conflict' : incomplete();
  if (!matchTransportSource(source, transport.deliveryId) || value.receipt &&
      (value.receipt.delivery_id !== transport.deliveryId || value.receipt.agent_id !== value.agentId ||
        transport.acceptanceId !== undefined && value.receipt.acceptance_id !== transport.acceptanceId ||
        value.executionId !== undefined && value.receipt.execution_id !== undefined && value.receipt.execution_id !== value.executionId)) return 'conflict';
  if (transport.batch && (!transport.batch.deliveryIds.includes(transport.deliveryId) ||
      value.executionId !== undefined && transport.batch.executionId !== value.executionId)) return 'conflict';
  return value.receipt && transport.acceptanceId && value.executionId && transport.batch ? 'bound' : incomplete();
}

/** Start observation, prove the matching run is armed, then let the provider publish. */
export async function requestTransportDelivery(request: NativeWorkerRequest, body: { wakeId: string; source: TransportDeliverySource },
  delivery: PreparedTransportDelivery, deadline: number, signal: AbortSignal): Promise<TerminalEvidence> {
  const cancellation = new AbortController();
  const combined = AbortSignal.any([signal, cancellation.signal]);
  let settled = false;
  const terminal = request<TerminalEvidence>('/trial/run', body, Math.max(1, deadline - Date.now()) + 8000, combined)
    .finally(() => { settled = true; });
  try {
    let publishing = false;
    const publish = boundedTransportCall(async bound => {
      for (;;) {
        const status = await request<{ state: string; wakeId?: string; source?: TransportDeliverySource }>(
          '/trial/run', undefined, Math.max(1, deadline - Date.now()), bound);
        if (settled) return;
        if (['waiting', 'observing'].includes(status.state) && status.wakeId === body.wakeId && status.source && sameSource(status.source, body.source)) break;
        await pause(20, undefined, { signal: bound });
      }
      bound.throwIfAborted();
      publishing = true;
      await delivery.publish(bound);
    }, deadline, combined);
    // A rejected run never publishes; a provider failure aborts the owned request.
    await Promise.race([publish, terminal]);
    if (publishing) await publish;
    return await terminal;
  } finally { cancellation.abort(); }
}
