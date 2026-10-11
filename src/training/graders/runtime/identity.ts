import type { DecisionBackend } from '../../contracts/grading.js';
import { decisionModels, graderForModel, stableDigest, type Grader } from '../format/index.js';

/** Shared by calibration and grading; pins routing in addition to reported model. */
export async function decisionBackendIdentity(grader: Grader, backend: DecisionBackend, signal?: AbortSignal): Promise<string> {
  const model = grader.model!;
  return stableDigest({ configured: model, reported: await backend.identity(signal),
    ...(model.backend === 'teacher' ? { teacher: grader.teachers.find(t => t.id === model.teacher) } : {}) });
}

/** Probe every referenced route; omitted routes retain their pinned calibration identity. */
export async function decisionModelIdentities(grader: Grader, backends: Record<string, DecisionBackend>,
  signal?: AbortSignal): Promise<Record<string, string>> {
  const identities: Record<string, string> = {};
  for (const model of decisionModels(grader)) {
    const backend = backends[model.id];
    if (!backend) continue;
    try { identities[model.id] = await decisionBackendIdentity(graderForModel(grader, model), backend, signal); }
    catch (cause) { throw new Error(`Decision model ${model.id}: identity failed`, { cause }); }
  }
  return identities;
}
