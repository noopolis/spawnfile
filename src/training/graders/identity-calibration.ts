import { allQuestions, decisionModels, stableDigest, type Grader } from './format/index.js';
import { createCalibrationIdentity, parseCalibration, type CalibrationFile } from './identity.js';

/** Explicit raw probabilities, with zero labeled observations; never a fitted calibration. */
export function createIdentityCalibration(grader: Grader, backendModel: string, promptTemplateVersion: string): CalibrationFile {
  if (grader.calibration !== 'identity') throw new Error('Identity calibration must be explicitly authored');
  return parseCalibration({ schema: 'paideia.grader-calibration.v1',
    identity: createCalibrationIdentity(grader, { backendModel, promptTemplateVersion,
      golden: stableDigest({ mode: 'identity', labels: null }), seed: '', exclusions: [] }),
    questions: Object.fromEntries(allQuestions(grader).map(question => [question.id, {
      model: decisionModels(grader)[0]!.id, status: 'uncalibrated', failures: ['explicit identity calibration; no labeled evidence'],
      metrics: { groups: 0, instances: 0, good: 0, bad: 0, baseRate: 0 },
    }])) });
}
