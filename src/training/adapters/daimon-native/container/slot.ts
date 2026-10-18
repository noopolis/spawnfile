import type { TrialSlot } from '../../../contracts/trial-slot.js';
import { isGrokLaunch, type NativeLaunch } from '../receipt/index.js';

/** Verify the project-written receipt before copying it to the owned child. */
export function assertLeasedLaunch(launch: NativeLaunch, slot: TrialSlot): void {
  if (slot.isolation === 'shared-uid') {
    if (isGrokLaunch(launch) || slot.workerUid !== process.geteuid?.()) {
      throw new Error('Native launch does not belong to the leased shared-uid slot');
    }
    if (!Number.isSafeInteger(slot.ports.base) || slot.ports.base < 1024 ||
        !Number.isSafeInteger(slot.ports.count) || slot.ports.count < 1 || slot.ports.base + slot.ports.count > 65536) {
      throw new Error('Invalid native leased port block');
    }
    if (launch.host.port < slot.ports.base || launch.host.port >= slot.ports.base + slot.ports.count) {
      throw new Error('Native control port escapes the leased slot');
    }
    const paths: Record<string, { source: string; target: string }[]> = {
      workspace: [launch.workspace],
      controlRoot: [{ source: launch.controlRoot, target: launch.controlRoot }],
    };
    for (const row of launch.projections) {
      const name = row.role === 'home' ? 'runtimeHome' : row.role;
      (paths[name] ??= []).push(row);
    }
    for (const [name, root] of Object.entries(slot.roots)) {
      const matches = paths[name];
      const declared = matches?.[0];
      if (matches?.length !== 1 || !declared || declared.source !== root || declared.target !== root) {
        throw new Error(`Native launch differs from leased slot root: ${name}`);
      }
    }
    return;
  }
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
