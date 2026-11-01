import type { SubjectAdapterRegistration } from '../../../training/index.js';

/**
 * Daimon subjects train only as production-booted trials: `spawnfile train`
 * supplies each run's trial launcher (see `booted/`). The registration exists
 * so the core accepts `--runtime daimon` for planning and dry-run estimates.
 */
export const daimonTrainingSubject: SubjectAdapterRegistration = {
  create() {
    throw new Error('Daimon subjects train as production-booted trials; run them through `spawnfile train --auth-profile <name>`');
  },
};
