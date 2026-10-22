import type { NativeReceipt } from '../types.js';

export type TransportDeliverySource = { kind: 'transport'; deliveryId: string; deliveryIdPrefix?: never }
  | { kind: 'transport'; deliveryIdPrefix: string; deliveryId?: never };

export interface NativeWakeRequest {
  token?: string;
  agent_id: string;
  delivery_id: string;
  event: { version: 'noopolis.daimon.wake.v2'; kind: 'manual' | 'message' | 'schedule' | 'external'; text: string; occurred_at: string };
}
export interface NativeAcceptance {
  state: 'accepted'; acceptance_id: string;
  version?: string; agent_id?: string; delivery_id?: string; request_digest?: string; accepted_at?: string;
}
export type NativeAcceptanceResult = NativeAcceptance | {
  state: 'rejected' | 'stopped'; code: string; version?: string;
  blocked?: { version: string; reason: string; retry_after_ms: number };
};
export interface TransportEvidence {
  source: TransportDeliverySource;
  deliveryId?: string;
  acceptanceId?: string;
  /** Verbatim producer metadata; no token and no second task-clock projection. */
  deliveries: { acceptanceId: string; deliveryId: string; event: NativeWakeRequest['event'] }[];
  /** Complete only when the public active execution projection was observed. */
  batch?: { executionId: string; deliveryIds: string[]; observedAt: string };
  /** Every selected delivery, including peers without a route-observed envelope. */
  selectedDeliveries?: { deliveryId: string; executionIds: string[]; receipt?: NativeReceipt }[];
  /** All observed executions of selected deliveries, including deferred revisits. */
  batches?: { executionId: string; deliveryIds: string[]; observedAt: string;
    allowances?: { source: 'availability'; observedAt: string; budget: unknown } }[];
  deferredDeliveryIds: string[];
  /** Selected across this trial's wakes; later input cannot erase unfinished work. */
  unresolvedDeliveryIds: string[];
  /** A current control observation, never claimed to be the model's rendered snapshot. */
  allowances?: { source: 'availability'; observedAt: string; budget: unknown };
  renderedAllowances: 'unavailable-public-api';
}
export type TransportRunState = { state: 'idle' } | {
  state: 'waiting' | 'observing'; wakeId: string; source: TransportDeliverySource;
};
