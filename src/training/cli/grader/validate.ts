import { readFile } from 'node:fs/promises';
import { loadGrader, loadLabels, parseCalibrationJson, createCalibrationIdentity, checkCalibration } from '../../graders/index.js';
import { validateStoredVotes } from '../../graders/labeling/index.js';
import { DECISION_PROMPT_VERSION } from '../../inference/decision/index.js';
import { backendIdentity, graderBackend, type GraderDependencies } from './backend.js';
import { readExclusions } from './exclusions.js';

export async function runValidate(graderFile: string, dependencies: GraderDependencies = {}): Promise<{ status: 'valid'; calibration: boolean }> {
  const grader = await loadGrader(graderFile);
  const loaded = await loadLabels(grader.golden, grader);
  validateStoredVotes(grader, loaded.labels, { resolved: true });
  let source: string;
  try { source = await readFile(grader.calibration, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'valid', calibration: false };
    throw error;
  }
  const calibration = parseCalibrationJson(source);
  const exclusions = await readExclusions(calibration.identity.exclusions.map(item => item.dataset));
  const identity = createCalibrationIdentity(grader, {
    backendModel: await backendIdentity(grader, graderBackend(grader, dependencies)),
    promptTemplateVersion: DECISION_PROMPT_VERSION, golden: loaded.goldenDigest,
    seed: calibration.identity.seed, exclusions: exclusions.identities,
  });
  // Validation checks freshness; the calibration command owns the quality verdict.
  const check = checkCalibration({ ...grader, uncalibrated: 'teacher' }, calibration, identity);
  if (!check.ok) throw new Error(check.refusals.join('\n'));
  return { status: 'valid', calibration: true };
}
