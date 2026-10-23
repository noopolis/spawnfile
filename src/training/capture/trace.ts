import { isDeepStrictEqual } from 'node:util';
import type { Observation, ObservationCoverage } from '../contracts/execution.js';

export interface CapturedCall {
  id: string;
  wake_id: string;
  tool: string;
  args: unknown;
  result?: unknown;
  success?: boolean;
  dispatch?: Observation;
  completion?: Observation;
}

/** Ingestion order is presentation only. Source sequences and causal edges prove order. */
export function captureObservation(events: readonly Observation[], event: Observation): Observation[] {
  if (!event.id || !event.source || !event.trialId || !event.wakeId ||
      !Number.isSafeInteger(event.seq) || event.seq < 0 || !Number.isFinite(Date.parse(event.timestamp))) {
    throw new Error('Malformed native observation identity');
  }
  if (events.some(item => item.trialId !== event.trialId)) throw new Error('Cross-trial observation');
  const duplicate = events.find(item => item.id === event.id);
  if (duplicate) {
    if (!isDeepStrictEqual(duplicate, event)) throw new Error(`Conflicting event ${event.id}`);
    return [...events];
  }
  if (events.some(item => item.source === event.source && item.seq === event.seq)) {
    throw new Error('Conflicting source sequence');
  }
  return [...events, structuredClone(event)];
}

export function capturedCalls(events: readonly Observation[]): CapturedCall[] {
  const calls = new Map<string, CapturedCall>();
  for (const event of events) {
    if (event.type !== 'tool.dispatch' && event.type !== 'tool.complete') continue;
    if (!event.callId || !event.tool) throw new Error('Tool observation lacks native call identity');
    const call = calls.get(event.callId) ?? {
      id: event.callId, wake_id: event.wakeId, tool: event.tool, args: event.args,
    };
    if (call.tool !== event.tool || call.wake_id !== event.wakeId) throw new Error('Conflicting call lineage');
    if (event.type === 'tool.dispatch') {
      if (call.dispatch) throw new Error('Duplicate call dispatch');
      call.dispatch = event;
      call.args = event.args;
    } else {
      if (call.completion) throw new Error('Duplicate call completion');
      call.completion = event;
      call.result = event.result;
      call.success = event.success;
    }
    calls.set(event.callId, call);
  }
  return [...calls.values()];
}

export function happensBefore(
  first: Observation, second: Observation, events: readonly Observation[],
  coverage: readonly ObservationCoverage[],
): boolean | undefined {
  if (first.id === second.id) return false;
  const tools = coverage.filter(row => row.channel === 'tools');
  if (first.source === second.source && tools.length > 0 && tools.every(row =>
      row.ordering === 'source' || row.ordering === 'causal')) return first.seq < second.seq;
  const byId = new Map(events.map(event => [event.id, event]));
  const pending = [...(second.causalParents ?? [])];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === first.id) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(...(byId.get(id)?.causalParents ?? []));
  }
  return undefined;
}

export function completeToolScope(closed: boolean, coverage: readonly ObservationCoverage[]): boolean {
  const tools = coverage.filter(row => row.channel === 'tools');
  return closed && tools.length > 0 && tools.every(row => row.completeness === 'complete');
}
