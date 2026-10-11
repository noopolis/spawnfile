import type { DecisionBackend } from '../../contracts/grading.js';
import { stableDigest, type Grader } from '../format/index.js';

/** Shared by calibration and grading; pins routing in addition to reported model. */
export async function decisionBackendIdentity(grader: Grader, backend: DecisionBackend): Promise<string> {
  return stableDigest({ configured: grader.model, reported: await backend.identity(),
    ...(grader.model.backend === 'teacher' ? { teacher: grader.teachers.find(t => t.id === (grader.model as { teacher: string }).teacher) } : {}) });
}
