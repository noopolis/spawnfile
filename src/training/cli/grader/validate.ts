import { readFile } from 'node:fs/promises';
import { loadGrader, loadLabels, parseCalibration, calibrationIdentitySchema, createCalibrationIdentity, checkCalibration, decisionModelIdentities, stableDigest } from '../../graders/index.js';
import { validateStoredVotes } from '../../graders/labeling/index.js';
import { DECISION_PROMPT_VERSION } from '../../inference/decision/index.js';
import { graderBackends, type GraderDependencies } from './backend.js';
import { readExclusions } from './exclusions.js';

export async function runValidate(graderFile: string, dependencies: GraderDependencies = {}, signal?: AbortSignal): Promise<{ status: 'valid'; calibration: boolean }> {
  const grader = await loadGrader(graderFile);
  const loaded = await loadLabels(grader.golden, grader);
  validateStoredVotes(grader, loaded.labels, { resolved: true });
  let source: string;
  try { source = await readFile(grader.calibration, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'valid', calibration: false };
    throw error;
  }
  const value: unknown = JSON.parse(source);
  if (value !== null && typeof value === 'object' && 'identity' in value &&
    !calibrationIdentitySchema.safeParse(value.identity).success) {
    throw new Error('calibration file is stale or from an older version; re-run grader calibrate');
  }
  const calibration = parseCalibration(value);
  const exclusions = await readExclusions(calibration.identity.exclusions.map(item => item.dataset));
  const modelIdentities = await decisionModelIdentities(grader, graderBackends(grader, dependencies), signal);
  const identity = createCalibrationIdentity(grader, {
    backendModel: grader.models ? stableDigest(modelIdentities) : modelIdentities.default!,
    ...(grader.models ? { modelIdentities } : {}),
    promptTemplateVersion: DECISION_PROMPT_VERSION, golden: loaded.goldenDigest,
    seed: calibration.identity.seed, exclusions: exclusions.identities,
  });
  // Validation checks freshness; the calibration command owns the quality verdict.
  const check = checkCalibration(grader, calibration, identity, { quality: false });
  if (!check.ok) throw new Error(check.refusals.join('\n'));
  return { status: 'valid', calibration: true };
}
