import { join } from 'node:path';
import { createGrokSlotFreshnessStore, type GrokSlotFreshnessOptions, type GrokSlotFreshnessStore } from '../child/index.js';

/** The experiment-state file holding every slot's recycle generation floor and pending nonce. */
export const experimentSlotFreshnessFile = 'grok-slot-freshness.json';

/**
 * The one Paideia-owned slot freshness store for an experiment.
 *
 * The experiment runner creates it inside its own durable state root and passes
 * the same store to subject preparation (`prepareNativeSubject` mints from it)
 * and to `NativeChildExecution.grokSlots` (the child accepts the verified slot
 * receipt into it), so integrations never configure a freshness file. Living
 * beside the run's other state, it survives resume and container replacement,
 * which is what keeps a generation floor from ever moving backwards. Nothing is
 * written until a broker slot first requests a nonce.
 */
export function createExperimentSlotFreshness(stateRoot: string, options?: GrokSlotFreshnessOptions): GrokSlotFreshnessStore {
  return createGrokSlotFreshnessStore(join(stateRoot, experimentSlotFreshnessFile), options);
}
