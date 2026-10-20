import { assertLeasedLaunch } from '../container/index.js';
import { grokBrokerLaunchSchema, type NativeLaunch } from '../receipt/index.js';
import type { GrokSlotFreshness } from '../child/index.js';
import type { PrepareNativeSubjectOptions, ProvisionedSubject } from './types.js';

/**
 * Prepare one native subject on a leased slot, before any trial bytes are written.
 *
 * The order is the contract. A broker (non-shared-uid) slot mints this trial's
 * recycle nonce and generation floor from the experiment's freshness store
 * BEFORE the provisioner runs, so the slot receipt the recycle publishes can only
 * be this trial's. The provisioner's result is then refused unless its broker
 * section parses as launch.v2 `broker`, echoes exactly that nonce and floor, and
 * the launch fields it implies pass the same leased-slot verifier the adapter
 * applies at start. A shared-uid slot admits Codex only and mints nothing; a
 * Codex result is returned unchanged.
 */
export async function prepareNativeSubject(options: PrepareNativeSubjectOptions): Promise<ProvisionedSubject> {
  const { slot, engine, agentId, provisioner, signal } = options;
  signal.throwIfAborted();
  const shared = slot.isolation === 'shared-uid';
  if (shared && engine === 'grok') throw new Error('A shared-uid slot cannot host a brokered Grok subject');
  if (!shared && engine !== 'grok') throw new Error('A broker slot lease hosts Grok subjects only');
  let freshness: GrokSlotFreshness | undefined;
  if (!shared) {
    if (!options.freshness) throw new Error('A broker slot requires the experiment slot freshness store');
    freshness = await options.freshness.request(slot.index);
    signal.throwIfAborted();
  }
  const result = await provisioner.provision({ slot, engine, agentId, ...(freshness ? { freshness } : {}),
    trialRoots: options.trialRoots, signal });
  signal.throwIfAborted();
  if (result.agent.engine !== engine || result.agent.id !== agentId) throw new Error('Provisioned subject names another agent or engine');
  const homes = result.projections.filter(row => row.role === 'home');
  if (homes.length !== 1) throw new Error('Provisioned subject must declare exactly one home projection');
  if (result.roots.workspace !== result.workspace.source || result.roots.home !== homes[0]!.source) {
    throw new Error('Provisioned subject roots differ from its workspace and home projection');
  }
  const host = { bindHost: '127.0.0.1' as const, port: result.ports.control };
  if (!freshness) {
    if (result.broker !== undefined || result.generation !== undefined) throw new Error('A Codex subject carries no broker slot evidence');
    assertLeasedLaunch({ ...result, controlRoot: result.roots.control, host } as unknown as NativeLaunch, slot);
    return result;
  }
  const parsed = grokBrokerLaunchSchema.safeParse(result.broker);
  if (!parsed.success) throw new Error('Provisioned Grok broker section does not satisfy launch.v2');
  const broker = parsed.data;
  if (broker.expectedNonce !== freshness.expectedNonce || broker.minGeneration !== freshness.minGeneration) {
    throw new Error('Provisioned Grok broker does not echo this trial\'s slot freshness');
  }
  if (result.generation !== undefined && (!Number.isSafeInteger(result.generation) || result.generation < freshness.minGeneration)) {
    throw new Error('Provisioned slot generation is below the evaluator freshness floor');
  }
  if (result.credentials.length || result.projections.length !== 1) {
    throw new Error('A brokered Grok subject carries no credentials and projects only its slot runtime home');
  }
  // The verifier reads only identity, paths and the control port; the rest of launch.v2 does not exist yet.
  assertLeasedLaunch({ ...result, broker, controlRoot: result.roots.control, host } as unknown as NativeLaunch, slot);
  return { ...result, broker };
}
