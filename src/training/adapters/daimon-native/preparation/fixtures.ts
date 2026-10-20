import type { TrialSlot } from '../../../contracts/trial-slot.js';
import type { GrokSlotFreshness } from '../child/index.js';
import type { GrokBrokerLaunch } from '../receipt/index.js';
import type { NativeTrialRoots, ProvisionedSubject, SubjectProvisionInput, SubjectProvisioner } from './types.js';

/** Test-only shapes of a Spawnfile-style training slot; never provisioning evidence. */
export const grokSlotRoot = '/run/training/slots/1';
export const grokContextRoot = '/run/paideia';

export function grokLease(): TrialSlot {
  return { index: 1, workerUid: 2201, ports: { base: 20100, count: 100 }, roots: {
    workspace: `${grokSlotRoot}/workspace`, runtimeHome: `${grokSlotRoot}/runtime-home`, workerHome: '/run/daimon-workers/2201',
    usageLedger: `${grokSlotRoot}/usage/usage.jsonl`, preflightReceipt: `${grokSlotRoot}/preflight.json`, controlRoot: `${grokSlotRoot}/state`,
    home: `${grokSlotRoot}/runtime-home`, control: `${grokSlotRoot}/state`, context: grokContextRoot } };
}

export function codexLease(): TrialSlot {
  return { index: 2, workerUid: process.geteuid!(), isolation: 'shared-uid', roots: {}, ports: { base: 20200, count: 100 } };
}

export function grokBroker(freshness: GrokSlotFreshness): GrokBrokerLaunch {
  const evaluatorPaths = [{ role: 'run-root', path: '/run/training/run' }, { role: 'context', path: grokContextRoot },
    { role: 'sealed-inputs', path: '/run/training/sealed' }, { role: 'judge-home', path: '/run/training/grants' },
    { role: 'slot-ledger', path: `${grokSlotRoot}/usage` }, { role: 'context', path: '/run/training/slots/0' }] as const;
  return { projectionVersion: 'noopolis.daimon.grok-broker-projection.v3', workerConfigVariant: 'unclocked',
    projectionSha256: 'a'.repeat(64), slot: 1, workerUid: 2201, workerHomePath: '/run/daimon-workers/2201', architecture: 'arm64',
    usageLedgerPath: `${grokSlotRoot}/usage/usage.jsonl`, seccompProfileSha256: 'b'.repeat(64), profileSha256: 'c'.repeat(64),
    denyPaths: [...evaluatorPaths.map(row => row.path), `${grokSlotRoot}/state`].sort(),
    limits: { maxRequests: 24, maxTokens: 400000, timeoutMs: 480000 }, evaluatorPaths: evaluatorPaths.map(row => ({ ...row })),
    slotPreflightReceipt: `${grokSlotRoot}/preflight.json`, ...freshness };
}

export function grokSubject(freshness: GrokSlotFreshness): ProvisionedSubject {
  const workspace = `${grokSlotRoot}/workspace`, home = `${grokSlotRoot}/runtime-home`;
  return { agent: { id: 'agent:writer', engine: 'grok', model: 'grok-4.6', reasoningEffort: 'low' },
    workspace: { source: workspace, target: workspace }, projections: [{ role: 'home', source: home, target: home }],
    credentials: [], broker: grokBroker(freshness), generation: freshness.minGeneration,
    roots: { workspace, home, control: `${grokSlotRoot}/state`, context: grokContextRoot },
    ports: { control: 20101, moltnet: 20100 }, env: { MOLTNET_TOKEN: 'fixture' } };
}

export function codexSubject(roots: NativeTrialRoots): ProvisionedSubject {
  const home = `${roots.root}/home`;
  return { agent: { id: 'agent:writer', engine: 'codex', model: 'gpt-5.5' },
    workspace: { source: roots.workspace, target: roots.workspace },
    projections: [{ role: 'home', source: home, target: home },
      { role: 'memory', source: `${roots.root}/memory`, target: `${roots.root}/memory` },
      { role: 'transport', source: `${roots.runtimeHome}/native/moltnet`, target: `${roots.runtimeHome}/native/moltnet` }],
    credentials: [{ source: '/run/paideia-auth/codex', target: `${home}/.daimon-inbound/codex-auth` }],
    roots: { workspace: roots.workspace, home, control: `${roots.runtimeHome}/native/root-control/acceptance` },
    ports: { control: 20201, moltnet: 20200 }, env: {} };
}

export const trialRoots = (root = '/trials/t1'): NativeTrialRoots =>
  ({ root, workspace: `${root}/workspace`, control: `${root}/control`, runtimeHome: `${root}/runtime` });

/** Records every call in order; `shape` decides what the provisioner answers. */
export function fakeProvisioner(shape: (input: SubjectProvisionInput) => ProvisionedSubject, log: string[] = []): SubjectProvisioner & { inputs: SubjectProvisionInput[] } {
  const inputs: SubjectProvisionInput[] = [];
  return { inputs, provision: async input => { log.push('provision'); inputs.push(input); return shape(input); } };
}
