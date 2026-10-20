import { describeNativeFailure, validateNativeFrame } from '../evidence/index.js';
import type { NativeActivity, NativeEvidence } from '../types.js';
import type { TransportEvidence } from './types.js';

/** A completed disposition is not terminal execution telemetry: validate both. */
export function validateTransportExecutions(evidence: TransportEvidence, native: NativeEvidence,
  activity: NativeActivity, agentId: string): void {
  if (!evidence.batch) throw new Error('Transport execution closed without observable batch membership');
  if (!evidence.selectedDeliveries?.length) throw new Error('Transport selection evidence is missing');
  const owned = new Set<string>();
  for (const selected of evidence.selectedDeliveries) {
    const receipt = selected.receipt;
    if (!receipt || !selected.executionIds.length) throw new Error('Transport delivery omitted execution binding');
    validateNativeFrame(activity, receipt, native.traces, agentId, receipt.execution_id);
    // Without a receipt-bound final execution there is no retry to excuse: judge every attempt.
    const settling = selected.executionIds.includes(receipt.execution_id ?? '') ? receipt.execution_id : undefined;
    for (const executionId of selected.executionIds) {
      if (!evidence.batches?.some(batch => batch.executionId === executionId && batch.deliveryIds.includes(selected.deliveryId))) {
        throw new Error('Transport execution closed without observable batch membership');
      }
      const trace = native.traces.find(row => row.turn_id === executionId);
      if (!trace) throw new Error('Transport execution omitted terminal telemetry');
      owned.add(executionId);
      // Daimon retries a failed attempt under a new execution and records the one that
      // settled the delivery as receipt.execution_id. Earlier attempts stay in the
      // retained traces as evidence; only the settling execution decides success.
      if (settling && executionId !== settling) continue;
      if (trace.status !== 'completed') throw new Error(describeNativeFailure(receipt, trace, native.usage));
      if (!native.usage.some(row => row.wake === executionId)) throw new Error('Transport execution omitted token usage evidence');
    }
  }
  // This home was empty at trial startup. Reconcile its entire retained terminal
  // history, including attempts that opened and closed between activity polls.
  // Receipt retries may erase a binding, but cannot erase that attempt's trace.
  if (native.traces.some(trace => !owned.has(trace.turn_id))) throw new Error('Transport terminal trace omitted execution ownership');
}
