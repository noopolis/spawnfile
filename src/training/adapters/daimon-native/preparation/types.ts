import type { TrialSlot } from '../../../contracts/trial-slot.js';
import type { GrokSlotFreshness, GrokSlotFreshnessStore } from '../child/index.js';
import type { GrokBrokerLaunch, NativeLaunch } from '../receipt/index.js';

export type NativeSubjectEngine = NativeLaunch['agent']['engine'];

/** The evaluator's own per-trial directories (structurally the experiment runner's `TrialPaths`). */
export interface NativeTrialRoots { root: string; workspace: string; control: string; runtimeHome: string }

export interface SubjectProvisionInput {
  slot: TrialSlot;
  engine: NativeSubjectEngine;
  agentId: string;
  /**
   * This trial's recycle nonce and generation floor, minted by Paideia before the
   * provisioner runs. Present for every broker (non-shared-uid) slot: the provisioner
   * sends the nonce with its recycle request and echoes both into `broker`.
   */
  freshness?: GrokSlotFreshness;
  trialRoots: NativeTrialRoots;
  signal: AbortSignal;
}

/**
 * Everything the provisioner resolved for one leased slot, before any trial bytes
 * are written. The fields are launch receipt fields; nothing here is recomputed
 * by Paideia, which only validates them against the lease and its freshness.
 */
export interface ProvisionedSubject {
  agent: NativeLaunch['agent'];
  workspace: NativeLaunch['workspace'];
  projections: NativeLaunch['projections'];
  credentials: NativeLaunch['credentials'];
  /** Required for Grok, forbidden for Codex. Carried verbatim into launch.v2. */
  broker?: GrokBrokerLaunch;
  /**
   * Resolved subject roots: `workspace` and `home` are the workspace and home
   * projection sources, `control` the launch control root. Grok also names
   * `context`, the denied evaluator root that holds per-trial control inputs.
   */
  roots: Readonly<Record<string, string>> & { readonly workspace: string; readonly home: string; readonly control: string };
  /** `control` is the worker control port; other named ports stay provisioner-owned. */
  ports: Readonly<Record<string, number>> & { readonly control: number };
  /** The slot generation the provisioner's recycle published. */
  generation?: number;
  /** Subject environment entries the caller writes into the launch env file. */
  env: Readonly<Record<string, string>>;
}

/** Implemented by the slot owner (for example Spawnfile's training lease); satisfied structurally. */
export interface SubjectProvisioner {
  provision(input: SubjectProvisionInput): Promise<ProvisionedSubject>;
}

export interface PrepareNativeSubjectOptions {
  slot: TrialSlot;
  engine: NativeSubjectEngine;
  agentId: string;
  provisioner: SubjectProvisioner;
  /** Required for broker slots: the experiment's persisted freshness store. */
  freshness?: GrokSlotFreshnessStore;
  trialRoots: NativeTrialRoots;
  signal: AbortSignal;
}
