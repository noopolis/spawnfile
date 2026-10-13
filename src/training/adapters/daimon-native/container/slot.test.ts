import { expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { launchFixture } from '../test-fixtures.js';
import { grokLaunchFrom } from '../grok-fixtures.js';
import { assertLeasedLaunch } from './slot.js';

it('binds every native receipt identity, projection and control port to the leased descriptor', async () => {
  const f = await launchFixture();
  try {
    const codex = structuredClone(f.launch);
    const launch = await grokLaunchFrom(f.launch, f.root);
    launch.workspace.target = launch.workspace.source;
    launch.projections[0]!.target = launch.projections[0]!.source;
    const slot = { index: launch.broker.slot, workerUid: launch.broker.workerUid,
      roots: { workspace: launch.workspace.source, runtimeHome: launch.projections[0]!.source,
        workerHome: launch.broker.workerHomePath, usageLedger: launch.broker.usageLedgerPath,
        preflightReceipt: launch.broker.slotPreflightReceipt, controlRoot: launch.controlRoot },
      ports: { base: launch.host.port, count: 1 } };
    expect(() => assertLeasedLaunch(launch, slot)).not.toThrow();
    expect(() => assertLeasedLaunch(codex, slot)).toThrow('broker slot');
    for (const patch of [{ index: slot.index + 1 }, { workerUid: slot.workerUid + 1 }]) {
      expect(() => assertLeasedLaunch(launch, { ...slot, ...patch })).toThrow('identity');
    }
    for (const name of Object.keys(slot.roots)) {
      expect(() => assertLeasedLaunch(launch, { ...slot, roots: { ...slot.roots, [name]: '/wrong' } })).toThrow('root');
    }
    for (const base of [launch.host.port - 1, launch.host.port + 1]) {
      expect(() => assertLeasedLaunch(launch, { ...slot, ports: { base, count: 1 } })).toThrow('escape');
    }
    expect(() => assertLeasedLaunch({ ...launch, workspace: { ...launch.workspace, target: '/wrong' } }, slot)).toThrow('escape');
    expect(() => assertLeasedLaunch({ ...launch, projections: [{ ...launch.projections[0]!, target: '/wrong' }] }, slot)).toThrow('escape');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
