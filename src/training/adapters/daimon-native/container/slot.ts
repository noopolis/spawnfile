import type { TrialSlot } from '../../../contracts/trial-slot.js';
import { isGrokLaunch, type NativeLaunch } from '../receipt/index.js';

/** Verify the project-written receipt before copying it to the owned child. */
export function assertLeasedLaunch(launch: NativeLaunch, slot: TrialSlot): void {
  if (!isGrokLaunch(launch)) throw new Error('Leased native launch requires broker slot evidence');
  if (launch.broker.slot !== slot.index || launch.broker.workerUid !== slot.workerUid) {
    throw new Error('Native launch does not belong to the leased slot identity');
  }
  const paths = {
    workspace: launch.workspace.source,
    runtimeHome: launch.projections.find(row => row.role === 'home')!.source,
    workerHome: launch.broker.workerHomePath,
    usageLedger: launch.broker.usageLedgerPath,
    preflightReceipt: launch.broker.slotPreflightReceipt,
    controlRoot: launch.controlRoot,
  };
  for (const [name, path] of Object.entries(paths)) {
    if (slot.roots[name] !== path) throw new Error(`Native launch differs from leased slot root: ${name}`);
  }
  if (launch.workspace.target !== paths.workspace || launch.projections[0]!.target !== paths.runtimeHome ||
      launch.host.port < slot.ports.base || launch.host.port >= slot.ports.base + slot.ports.count) {
    throw new Error('Native launch paths or control port escape the leased slot');
  }
}
