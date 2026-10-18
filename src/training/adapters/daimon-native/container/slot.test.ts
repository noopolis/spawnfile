import { expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { launchFixture } from '../test-fixtures.js';
import { grokLaunchFrom } from '../grok-fixtures.js';
import { assertLeasedLaunch } from './slot.js';
import { loadNativeLaunch } from './manifest.js';
import type { TrialSlot } from '../../../contracts/trial-slot.js';

it('admits a shared-uid Codex lease through manifest loading and always checks its port block', async () => {
  const f = await launchFixture();
  const slot: TrialSlot = { index: 0, workerUid: process.geteuid!(), isolation: 'shared-uid', roots: {},
    ports: { base: f.launch.host.port, count: 100 } };
  try {
    expect(await loadNativeLaunch({ ...f.input, slot })).toEqual(f.launch);
    for (const port of [slot.ports.base, slot.ports.base + 99]) {
      f.launch.host.port = port; await f.save();
      await expect(loadNativeLaunch({ ...f.input, slot })).resolves.toBeDefined();
    }
    for (const port of [slot.ports.base - 1, slot.ports.base + 100]) {
      f.launch.host.port = port; await f.save();
      await expect(loadNativeLaunch({ ...f.input, slot })).rejects.toThrow('port escapes');
    }
    f.launch.host.port = slot.ports.base;
    for (const ports of [{ base: NaN, count: 100 }, { base: slot.ports.base, count: NaN },
      { base: 0, count: 65536 }, { base: 65535, count: 2 }, { base: slot.ports.base, count: 0 }]) {
      expect(() => assertLeasedLaunch(f.launch, { ...slot, ports })).toThrow('Invalid native leased port block');
    }
    expect(() => assertLeasedLaunch(f.launch, { ...slot, workerUid: slot.workerUid + 1 })).toThrow('shared-uid slot');
    const grok = await grokLaunchFrom(f.launch, f.root);
    expect(() => assertLeasedLaunch(grok, slot)).toThrow('shared-uid slot');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it('binds every declared Codex root and rejects unknown roots and mismatched source or target', async () => {
  const f = await launchFixture();
  try {
    const roots = { workspace: f.launch.workspace.source, controlRoot: f.launch.controlRoot,
      ...Object.fromEntries(f.launch.projections.map(row => [row.role === 'home' ? 'runtimeHome' : row.role, row.source])) };
    const slot: TrialSlot = { index: 0, workerUid: process.geteuid!(), isolation: 'shared-uid', roots,
      ports: { base: f.launch.host.port, count: 100 } };
    // Declared roots pin in-container paths too; the default fixture uses separate-container targets.
    f.launch.workspace.target = f.launch.workspace.source;
    for (const row of f.launch.projections) row.target = row.source;
    expect(() => assertLeasedLaunch(f.launch, slot)).not.toThrow();
    for (const name of [...Object.keys(roots), 'unknown']) {
      expect(() => assertLeasedLaunch(f.launch, { ...slot, roots: { ...roots, [name]: '/wrong' } })).toThrow('root');
    }
    for (const mount of [f.launch.workspace, ...f.launch.projections]) {
      for (const field of ['source', 'target'] as const) {
        const original = mount[field]; mount[field] = '/wrong';
        expect(() => assertLeasedLaunch(f.launch, slot)).toThrow('root');
        mount[field] = original;
      }
    }
    const home = f.launch.projections.find(row => row.role === 'home')!;
    f.launch.projections.push({ ...home, source: '/wrong' });
    expect(() => assertLeasedLaunch(f.launch, slot)).toThrow('root');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

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
