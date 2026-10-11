import type { NativeActivity, NativeAvailability, NativeHost, NativeReceipt } from '../types.js';
import { matchTransportSource } from './source.js';
import type { NativeAcceptance, NativeWakeRequest, TransportDeliverySource, TransportEvidence, TransportRunState } from './types.js';

interface ArmedRun {
  wakeId: string;
  evidence: TransportEvidence;
  first?: NativeAcceptance;
  resolve(value: NativeAcceptance): void;
}
interface Arrival { run: ArmedRun | undefined; request: NativeWakeRequest; outcome?: NativeAcceptance | 'refused' }
interface DeliveryArrivals { attempts: Arrival[]; decided: boolean }

/** Only the HTTP route calls accept. run() arms and observes this mailbox. */
export function createTransportDelivery(host: NativeHost, agentId: string) {
  let armed: ArmedRun | undefined;
  const seen = new Set<string>();
  const arrivals = new Map<string, DeliveryArrivals>();
  const envelopes = new Map<string, TransportEvidence['deliveries'][number]>();
  const selected = new Map<string, NativeReceipt | undefined>();
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
      if (!selected.has(request.delivery_id)) selected.set(request.delivery_id, undefined);
      if (!current.first) {
        current.first = result;
        current.evidence.deliveryId = request.delivery_id;
        current.evidence.acceptanceId = result.acceptance_id;
        current.evidence.deliveries = [envelopes.get(request.delivery_id)!];
        current.resolve(result);
      }
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
      const current: ArmedRun = { wakeId, evidence, resolve };
      armed = current;
      return {
        accepted, evidence,
        observe(receipt: NativeReceipt, activity: NativeActivity, availability: NativeAvailability, executionId?: string) {
          const batch = activity.executions?.find(row => row.agent_id === agentId && row.delivery_ids.includes(evidence.deliveryId!));
          if (batch) {
            if (executionId !== undefined && batch.execution_id !== executionId) throw new Error('Transport execution binding changed');
            if (evidence.batch && evidence.batch.executionId === batch.execution_id &&
                JSON.stringify(evidence.batch.deliveryIds) !== JSON.stringify(batch.delivery_ids)) throw new Error('Transport batch membership changed');
            evidence.batch = { executionId: batch.execution_id, deliveryIds: [...batch.delivery_ids], observedAt: new Date().toISOString() };
            for (const id of batch.delivery_ids) if (!selected.has(id)) selected.set(id, undefined);
            // Read separately from active executions. This is current availability,
            // not the snapshot a daimon_inbox tool call might return to the model.
            const budget = availability.agents.find(row => row.agent_id === agentId)?.budget;
            if (budget !== undefined && !evidence.allowances) evidence.allowances = { source: 'availability', observedAt: new Date().toISOString(), budget };
          }
          const ids = evidence.batch?.deliveryIds ?? (evidence.deliveryId ? [evidence.deliveryId] : []);
          evidence.deliveries = ids.flatMap(id => envelopes.has(id) ? [envelopes.get(id)!] : []);
          for (const row of [...activity.items, receipt]) {
            if (row.agent_id === agentId && selected.has(row.delivery_id)) selected.set(row.delivery_id, row);
          }
          evidence.deferredDeliveryIds = [...selected].filter(([, row]) => row?.state === 'accepted' && row.deferred === true).map(([id]) => id);
          evidence.unresolvedDeliveryIds = [...selected].filter(([, row]) => row?.state !== 'completed').map(([id]) => id);
        },
        finish() { if (armed === current) armed = undefined; },
      };
    },
    async accept(request: NativeWakeRequest) {
      // Capture the arm before awaiting fsync. A request begun before this run
      // cannot bind merely because its acceptance completed after arming.
      const identity = JSON.stringify([request.agent_id, request.delivery_id]);
      const arrival: Arrival = { run: armed, request };
      const queue = arrivals.get(identity) ?? { attempts: [], decided: false };
      arrivals.set(identity, queue);
      if (!queue.decided) queue.attempts.push(arrival);
      let result;
      try { result = await host.accept(request); }
      catch (error) { arrival.outcome = 'refused'; bind(queue); throw error; }
      if (result.state !== 'accepted') {
        arrival.outcome = 'refused'; bind(queue);
        return result;
      }
      if (request.agent_id === agentId) {
        envelopes.set(request.delivery_id, { acceptanceId: result.acceptance_id, deliveryId: request.delivery_id, event: structuredClone(request.event) });
      }
      arrival.outcome = result; bind(queue);
      return result;
    },
  };
}
