import { z } from 'zod';
import type { JudgeCall } from '../../contracts/evaluation.js';
import { decompositionSchema } from '../decomposition/index.js';
import type { AtomicGradeResult } from './types.js';

/** Replay validates and retains the full evaluator-only atomic grade, including failed attempts. */
export function createAtomicGradeResultSchema(judgeCall: z.ZodType<JudgeCall>): z.ZodType<AtomicGradeResult> {
  const probability = z.number().finite().min(0).max(1), count = z.number().int().nonnegative();
  const digest = z.string().regex(/^[a-f0-9]{64}$/);
  const check = z.strictObject({ id: z.string(), template_id: z.string(), unit_id: z.string(), type: z.enum(['choice', 'noul', 'score']),
    instructions: z.string(), criteria: z.record(z.string(), z.string()), options: z.array(z.string()), expected: z.array(z.string()),
    projection: z.record(z.string(), z.unknown()), digest, status: z.enum(['ready', 'missing']), reasons: z.array(z.string()) });
  return z.strictObject({ schema: z.literal('paideia.atomic-grade.v1'), status: z.enum(['pass', 'fail', 'unknown', 'error']),
    score: probability.nullable(), coverage: probability, criticalGate: probability, obligationCoverage: probability, quality: probability,
    failure: z.strictObject({ cause: z.enum(['spend-cap', 'request-rejected']), reason: z.string() }).optional(),
    identity: z.strictObject({ definitionDigest: digest, templatesDigest: digest, outputDigest: digest, contextDigest: digest }),
    checks: z.array(z.strictObject({ check, occurrence: z.string(), unit: z.string(), kind: z.string(), dimension: z.string(),
      severity: z.enum(['critical', 'major', 'minor']), probability: probability.nullable(),
      decision: z.strictObject({ key: z.string(),
        status: z.enum(['ok', 'missing']), reason: z.string().optional(), failureCause: z.enum(['spend-cap', 'request-rejected']).optional(),
      }).optional() })),
    extraction: z.strictObject({ decomposition: decompositionSchema.optional(), receipts: z.array(z.record(z.string(), z.unknown())),
      judgeCalls: z.array(judgeCall), error: z.string().optional() }),
    receipts: z.array(z.strictObject({ requestId: z.string().min(1).optional(), billing: z.literal('api'), model: z.string(), endpoint: z.string(), inputTokens: count.nullable(),
      outputTokens: count.nullable(), usd: z.number().finite().nonnegative().nullable(), estimatedInputTokens: count,
      estimatedUsd: z.number().finite().nonnegative(), latencyMs: z.number().finite().nonnegative(), status: count.nullable() })),
    feedback: z.strictObject({ failed_check_count: count, omitted_failed_checks: count,
      failed_checks: z.array(z.strictObject({ template: z.string(), unit: z.string(), probability: probability.nullable() })) }),
    judgeCalls: z.array(judgeCall),
  }).superRefine((grade, context) => {
    const refused = grade.checks.some(score => score.decision?.failureCause);
    if (refused && !grade.failure) context.addIssue({ code: 'custom', message: 'Refused decision requires infrastructure failure' });
    if ((grade.failure && (grade.status !== 'error' || grade.score !== null)) || (grade.score === null && grade.status !== 'error')) {
      context.addIssue({ code: 'custom', message: 'Infrastructure failure requires an error with no score' });
    }
  });
}
