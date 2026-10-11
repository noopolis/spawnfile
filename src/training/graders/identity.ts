import { z } from 'zod';
import { teacherAccuracyFailures } from './calibration/index.js';
import { teacherPolicyDigest } from './labeling/index.js';
import { segmenterIdentity } from './instances.js';
import { allQuestions, optionsFor, parseSchema, identifier, probability, stableDigest, type Grader, type Labels } from './format/index.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const interval = z.tuple([probability, probability]).refine(([lo, hi]) => lo <= hi, 'unordered interval');
export const calibrationIdentitySchema = z.strictObject({
  questions: z.record(identifier, digest),
  expansion: z.array(z.tuple([identifier, digest])),
  promptTemplateVersion: z.string().min(1),
  segmenter: z.string().min(1),
  optionMapping: z.record(identifier, digest),
  backendModel: z.string().min(1),
  golden: digest,
  seed: z.string(),
  escalation: digest,
  escalationTeacher: digest,
  uncalibrated: z.enum(['refuse', 'teacher']),
  exclusions: z.array(z.strictObject({ dataset: z.string().min(1), digest })),
});
export type CalibrationIdentity = z.infer<typeof calibrationIdentitySchema>;

export const calibrationFileSchema = z.strictObject({
  schema: z.literal('paideia.grader-calibration.v1'),
  identity: calibrationIdentitySchema,
  questions: z.record(identifier, z.strictObject({
    status: z.enum(['calibrated', 'insufficient-evidence', 'uncalibrated', 'escalation-infeasible', 'unverified']),
    failures: z.array(z.string()),
    params: z.strictObject({ a: z.number(), b: z.number() }).optional(),
    band: z.tuple([probability, probability]).refine(([lo, hi]) => lo < hi, 'requires lo < hi').optional(),
    teacherAccuracy: z.strictObject({
      groups: z.number().int().nonnegative(), instances: z.number().int().nonnegative(),
      good: z.number().int().nonnegative(), bad: z.number().int().nonnegative(),
      agreement: probability, source: z.enum(['human', 'editor', 'independent']),
      failures: z.array(z.string()), warnings: z.array(z.string()),
    }).optional(),
    metrics: z.strictObject({
      groups: z.number().int().nonnegative(), instances: z.number().int().nonnegative(),
      good: z.number().int().nonnegative(), bad: z.number().int().nonnegative(),
      baseRate: probability,
      accuracy: probability.optional(), brier: probability.optional(), baseRateBrier: probability.optional(),
      ece: probability.nullable().optional(), eceInterval: interval.nullable().optional(), brierInterval: interval.optional(),
      falsePassRate: probability.optional(), falsePassInterval: interval.optional(), cascadeInterval: interval.optional(), agreement: probability.optional(),
      cascadeAccuracy: probability.optional(), escalationRate: probability.optional(), coverage: probability.optional(),
    }),
  })),
});
export type CalibrationFile = z.infer<typeof calibrationFileSchema>;

export function parseCalibration(value: unknown): CalibrationFile { return parseSchema(calibrationFileSchema, value); }
export function parseCalibrationJson(source: string): CalibrationFile { return parseCalibration(JSON.parse(source)); }
export { segmenterIdentity } from './instances.js';

export function createCalibrationIdentity(grader: Grader, supplied: Omit<CalibrationIdentity, 'questions' | 'expansion' | 'optionMapping' | 'segmenter' | 'escalation' | 'escalationTeacher' | 'uncalibrated'> & { segmenter?: string }): CalibrationIdentity {
  const questions = allQuestions(grader);
  return parseSchema(calibrationIdentitySchema, {
    ...supplied,
    escalation: stableDigest(grader.escalate),
    escalationTeacher: teacherPolicyDigest(grader.teachers.find(teacher => teacher.id === grader.escalate.to)!),
    uncalibrated: grader.uncalibrated,
    expansion: questions.map(question => [question.id, stableDigest(question)]),
    questions: Object.fromEntries(questions.map(question => [question.id, stableDigest(question)])),
    // Fixed A–P ordering; backend token extraction is owned by inference.
    optionMapping: Object.fromEntries(questions.map(question => [question.id, stableDigest(optionsFor(question).map((option, index) =>
      ({ option, token: String.fromCharCode(65 + index) })))])),
    segmenter: supplied.segmenter ?? segmenterIdentity(),
  });
}

export function goldenIdentity(labels: Labels): string { return stableDigest(labels); }

export interface CalibrationCheck {
  ok: boolean;
  refusals: string[];
  notCalibrated: string[];
}

/** Identity mismatches always refuse, including when teacher fallback is selected. */
export function checkCalibration(grader: Grader, calibration: CalibrationFile, identity: CalibrationIdentity, options: { quality?: boolean } = {}): CalibrationCheck {
  const refusals: string[] = [];
  const current = createCalibrationIdentity(grader, identity);
  for (const component of Object.keys(current) as (keyof CalibrationIdentity)[]) {
    if (stableDigest(calibration.identity[component]) !== stableDigest(current[component])) {
      refusals.push(`calibration identity mismatch: ${component}`);
    }
  }
  const notCalibrated = allQuestions(grader).filter(question => calibration.questions[question.id]?.status !== 'calibrated').map(question => question.id);
  if (options.quality !== false && grader.uncalibrated === 'refuse') {
    for (const id of notCalibrated) refusals.push(`question ${id}: ${calibration.questions[id]?.failures.join(', ') || 'not calibrated'}`);
  }
  if (options.quality !== false) {
    const forced = grader.model.backend === 'teacher' ? allQuestions(grader).map(question => question.id)
      : grader.uncalibrated === 'teacher' ? notCalibrated : [];
    for (const id of forced) {
      const accuracy = calibration.questions[id]?.teacherAccuracy;
      const failures = accuracy ? teacherAccuracyFailures(accuracy)
        : ['teacher.accuracy missing; re-run grader calibrate (agreement >= 0.85; groups >= 15; instances >= 30; good >= 5; bad >= 5)'];
      for (const failure of failures) refusals.push(`question ${id}: ${failure}`);
    }
  }
  return { ok: refusals.length === 0, refusals, notCalibrated };
}
