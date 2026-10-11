import type { NativeActivity, NativeAvailability, NativeHost, NativeReceipt, NativeTrace } from '../types.js';
import { matchTransportSource } from './source.js';
import type { NativeAcceptance, NativeWakeRequest, TransportDeliverySource, TransportEvidence, TransportRunState } from './types.js';

interface ArmedRun {
  wakeId: string;
  evidence: TransportEvidence;
  first?: NativeAcceptance;
  generation: number;
  pending: number;
  resolve(value: NativeAcceptance): void;
}
interface Arrival { run: ArmedRun | undefined; request: NativeWakeRequest; outcome?: NativeAcceptance | 'refused' }
interface DeliveryArrivals { attempts: Arrival[]; decided: boolean }

/** Trial admission is separate from Daimon's schema and acceptance responses. */
export class TransportAdmissionClosedError extends Error {
  constructor() { super('transport_admission_sealed'); }
}

/** Only the HTTP route calls accept. run() arms and observes this mailbox. */
export function createTransportDelivery(host: NativeHost, agentId: string) {
  let armed: ArmedRun | undefined;
  let sealed = true;
  const seen = new Set<string>();
  const admittedIdentities = new Set<string>();
  const agentAcceptances = new Map<string, string>();
  const arrivals = new Map<string, DeliveryArrivals>();
  const envelopes = new Map<string, TransportEvidence['deliveries'][number]>();
  const selected = new Map<string, { receipt?: NativeReceipt; executionIds: Set<string> }>();
  const batches = new Map<string, NonNullable<TransportEvidence['batches']>[number]>();
  const select = (id: string) => {
    if (!selected.has(id)) selected.set(id, { executionIds: new Set() });
    return selected.get(id)!;
  };
  const snapshot = (evidence: TransportEvidence) => {
    evidence.deliveries = [...selected.keys()].flatMap(id => envelopes.has(id) ? [structuredClone(envelopes.get(id)!)] : []);
    evidence.selectedDeliveries = [...selected].map(([deliveryId, row]) => ({ deliveryId,
      executionIds: [...row.executionIds], ...(row.receipt ? { receipt: structuredClone(row.receipt) } : {}) }));
    evidence.batches = structuredClone([...batches.values()]);
    evidence.deferredDeliveryIds = [...selected].filter(([, row]) => row.receipt?.state === 'accepted' && row.receipt.deferred === true).map(([id]) => id);
    evidence.unresolvedDeliveryIds = [...selected].filter(([, row]) => row.receipt?.state !== 'completed').map(([id]) => id);
  };
  const bind = (queue: DeliveryArrivals) => {
    if (queue.decided) return;
    while (queue.attempts[0]?.outcome === 'refused') queue.attempts.shift();
    const first = queue.attempts[0];
    if (!first?.outcome) return;
    const result = first.outcome as NativeAcceptance;
    queue.decided = true;
    const { run: current, request } = first;
    const fresh = !seen.has(result.acceptance_id);
    seen.add(result.acceptance_id);
    if (fresh && current && current === armed && request.agent_id === agentId && result.agent_id === agentId &&
        result.delivery_id === request.delivery_id && matchTransportSource(current.evidence.source, request.delivery_id)) {
      // Every matching acceptance is trial work, even if queued behind this batch.
      select(request.delivery_id);
      if (!current.first) {
        current.first = result;
        current.evidence.deliveryId = request.delivery_id;
        current.evidence.acceptanceId = result.acceptance_id;
        current.resolve(result);
      }
      snapshot(current.evidence);
    }
    queue.attempts.length = 0;
  };
  return {
    state(): TransportRunState {
      return armed ? { state: armed.first ? 'observing' : 'waiting', wakeId: armed.wakeId, source: armed.evidence.source } : { state: 'idle' };
    },
    begin(wakeId: string, source: TransportDeliverySource) {
      let resolve!: ArmedRun['resolve'];
      const accepted = new Promise<NativeAcceptance>(done => { resolve = done; });
      const evidence: TransportEvidence = { source, deliveries: [], deferredDeliveryIds: [], unresolvedDeliveryIds: [], renderedAllowances: 'unavailable-public-api' };
      const current: ArmedRun = { wakeId, evidence, resolve, generation: 0, pending: 0 };
      let observed: NativeReceipt[] = [];
      let nativePending: number | undefined;
      const disposed = (row: NativeReceipt) => ['completed', 'failed', 'stopped'].includes(row.state) ||
        row.state === 'accepted' && row.deferred === true && selected.has(row.delivery_id);
      const closed = (traces: NativeTrace[]) => nativePending === 0 && observed.every(disposed) &&
        [...agentAcceptances].every(([id, acceptance]) => observed.some(row =>
          row.delivery_id === id && row.acceptance_id === acceptance && disposed(row))) &&
        [...selected.values()].every(row => row.receipt && disposed(row.receipt) &&
          [...row.executionIds].every(id => traces.some(trace => trace.turn_id === id)));
      armed = current;
      return {
        accepted, evidence, closed,
        generation: () => current.generation,
        /** Synchronous admission/sealing linearization point: no await may split it. */
        seal(generation: number, traces: NativeTrace[]) {
          if (current !== armed || current.pending !== 0 || current.generation !== generation || !closed(traces)) return false;
          armed = undefined;
          sealed = true;
          return true;
        },
        observe(receipt: NativeReceipt, activity: NativeActivity, availability: NativeAvailability, executionId?: string) {
          observed = structuredClone([...activity.items, receipt].filter(row => row.agent_id === agentId));
          nativePending = availability.agents.find(row => row.agent_id === agentId)?.pending;
          for (const batch of activity.executions ?? []) {
            if (batch.agent_id !== agentId || !batch.delivery_ids.some(id => selected.has(id))) continue;
            const primary = batch.delivery_ids.includes(evidence.deliveryId!);
            if (primary && executionId !== undefined && batch.execution_id !== executionId) throw new Error('Transport execution binding changed');
            const previous = batches.get(batch.execution_id);
            if (previous && JSON.stringify(previous.deliveryIds) !== JSON.stringify(batch.delivery_ids)) throw new Error('Transport batch membership changed');
            const observedAt = new Date().toISOString();
            // Read separately from active executions. This is current availability,
            // not the snapshot a daimon_inbox tool call might return to the model.
            const budget = availability.agents.find(row => row.agent_id === agentId)?.budget;
            const allowances = budget === undefined ? undefined : { source: 'availability' as const, observedAt, budget };
            const observed = previous ?? { executionId: batch.execution_id, deliveryIds: [...batch.delivery_ids], observedAt, ...(allowances ? { allowances } : {}) };
            batches.set(batch.execution_id, observed);
            for (const id of batch.delivery_ids) select(id).executionIds.add(batch.execution_id);
            if (primary) {
              evidence.batch = { executionId: observed.executionId, deliveryIds: [...observed.deliveryIds], observedAt: observed.observedAt };
              evidence.allowances ??= allowances;
            }
          }
          for (const row of [...activity.items, receipt]) {
            const selection = selected.get(row.delivery_id);
            if (row.agent_id !== agentId || !selection) continue;
            const envelope = envelopes.get(row.delivery_id);
            if (envelope && row.acceptance_id !== envelope.acceptanceId) throw new Error('Transport receipt acceptance identity changed');
            selection.receipt = structuredClone(row);
            if (row.execution_id !== undefined) selection.executionIds.add(row.execution_id);
          }
          snapshot(evidence);
        },
        finish() { if (armed === current) { armed = undefined; sealed = true; } },
      };
    },
    async accept(value: unknown) {
      // Capture the arm before awaiting fsync. A request begun before this run
      // cannot bind merely because its acceptance completed after arming.
      // Only observe identity here. Daimon's host owns parsing and structured
      // schema rejection, including non-object JSON values.
      const request = value as NativeWakeRequest | null;
      const identity = JSON.stringify([request?.agent_id, request?.delivery_id]);
      // Once a run seals, only real native idempotency keys can pass until the
      // next arm. A publisher still in flight must see refusal, not start work
      // that the already-sealed terminal frame can never account for.
      if (!armed && sealed && !admittedIdentities.has(identity)) throw new TransportAdmissionClosedError();
      const current = armed;
      if (current) { current.generation++; current.pending++; }
      try {
        if (!request || typeof request.agent_id !== 'string' || typeof request.delivery_id !== 'string') return await host.accept(value);
        const arrival: Arrival = { run: armed, request };
        const queue = arrivals.get(identity) ?? { attempts: [], decided: false };
        arrivals.set(identity, queue);
        if (!queue.decided) queue.attempts.push(arrival);
        let result;
        try { result = await host.accept(value); }
        catch (error) { arrival.outcome = 'refused'; bind(queue); throw error; }
        if (result.state !== 'accepted') {
          arrival.outcome = 'refused'; bind(queue);
          return result;
        }
        if (result.agent_id === request.agent_id && result.delivery_id === request.delivery_id) admittedIdentities.add(identity);
        if (request.agent_id === agentId && result.agent_id === agentId && result.delivery_id === request.delivery_id && !envelopes.has(request.delivery_id)) {
          envelopes.set(request.delivery_id, { acceptanceId: result.acceptance_id, deliveryId: request.delivery_id, event: structuredClone(request.event) });
        }
        if (current && result.agent_id === agentId && result.delivery_id === request.delivery_id) {
          agentAcceptances.set(request.delivery_id, result.acceptance_id);
        }
        arrival.outcome = result; bind(queue);
        return result;
      } finally { if (current) { current.pending--; current.generation++; } }
    },
  };
}
