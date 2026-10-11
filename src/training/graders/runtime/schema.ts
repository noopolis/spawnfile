import { z } from 'zod';
import type { JudgeCall } from '../../contracts/evaluation.js';
import { calibrationIdentitySchema } from '../identity.js';
import type { GradeResult } from './types.js';

/** Persisted grading results use the host's existing, explicit judge-call schema. */
export function createGradeResultSchema(judgeCall: z.ZodType<JudgeCall>): z.ZodType<GradeResult> {
  const probability = z.number().finite().min(0).max(1);
  const count = z.number().int().nonnegative();
  const digest = z.string().regex(/^[a-f0-9]{64}$/);
  return z.strictObject({
    status: z.enum(['pass', 'fail', 'unknown']), score: probability, coverage: probability,
    gates: z.array(z.strictObject({ id: z.string().min(1), status: z.enum(['pass', 'fail', 'unknown', 'error']) })),
    questions: z.array(z.strictObject({ id: z.string().min(1), score: probability,
      instances: count, not_applicable: count, escalated: count, missing: count })),
    identity: z.strictObject({ calibration: calibrationIdentitySchema, calibrationDigest: digest,
      escalation: digest, teacherPolicy: digest, scoringPolicy: digest }),
    backendBilling: z.enum(['local', 'subscription', 'mixed']), judgeCalls: z.array(judgeCall),
    decisions: z.array(z.strictObject({ instance: z.string().min(1), model: z.string().min(1), status: z.enum(['ok', 'missing']) })).optional(),
  });
}
