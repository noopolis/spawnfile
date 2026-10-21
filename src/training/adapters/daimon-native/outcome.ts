import type { TerminalEvidenceMissing } from '../../contracts/execution.js';
import { bindTerminalEvidence } from './child/index.js';
import { wakeEvidenceFile, type TerminalEvidence, type TransportDeliverySource } from './worker/index.js';
import type { VerifiedNativeLaunch } from './receipt/index.js';

/** Runtime-local protected files, one per admitted wake; no filesystem discovery by consumers. */
export interface NativeTurnEvidence {
  schema: 'paideia.daimon-native.evidence.v1';
  wakes: { wakeId: string; executionId: string; executionIds: string[]; evidenceFile: string }[];
}

export function admittedNativeEvidence(value: TerminalEvidence, launch: VerifiedNativeLaunch, trialId: string,
  wakeId: string, ordinal: number, file: string, source: TransportDeliverySource | undefined,
  deliveries: Set<string>, wakeTimeoutMs?: number): NativeTurnEvidence['wakes'][number] | undefined {
  if (!value.activity || !value.receipt) return undefined;
  const wake = { wakeId, source, unevidenced: 'terminal-absent' as TerminalEvidenceMissing | undefined };
  let sealed = false;
  bindTerminalEvidence(wake, value, launch, trialId, () => { sealed = true; }, wakeTimeoutMs);
  if (sealed) throw new Error('Native terminal evidence attribution conflict');
  const delivery = value.receipt!.delivery_id;
  const own = (id: string) => launch.delivery === 'transport' ? deliveries.has(id) || id === delivery : id.startsWith(`${trialId}:`);
  const ids = new Set([value.executionId!]);
  for (const item of value.activity!.items) {
    if (item.agent_id !== launch.agent.id) throw new Error('Native activity evidence identity mismatch');
    // Trial deliveries are authoritative; native tool receipts are not deliveries.
    if ((launch.delivery === 'transport' && item.delivery_id.startsWith('moltnet:') ||
        /^[0-9a-f-]{36}:/u.test(item.delivery_id)) && !own(item.delivery_id)) {
      throw new Error('Native activity delivery identity mismatch');
    }
    if (own(item.delivery_id) && item.execution_id) ids.add(item.execution_id);
  }
  // The worker's admitted trial ledger retains revisits that the latest delivery
  // activity can no longer name. Legacy frames have only the activity projection.
  for (const row of value.native.accounting?.usage ?? []) {
    if (row.agent !== launch.agent.id || !row.wake) throw new Error('Native accounting evidence identity mismatch');
    ids.add(row.wake);
  }
  if (wake.unevidenced) return undefined;
  deliveries.add(delivery);
  return { wakeId, executionId: value.executionId!, executionIds: [...ids], evidenceFile: wakeEvidenceFile(file, ordinal) };
}
