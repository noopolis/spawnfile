import { z } from 'zod';
import { checkBinding, identifier, parseSchema, parseYaml, probability } from '../format/index.js';
import type { CheckTemplates } from '../decomposition/index.js';

const relativeFile = z.string().min(1).refine(value => !value.startsWith('/') &&
  !value.includes('\\') && !value.split('/').some(part => part === '..' || part === '.' || part === '') && !value.includes('\0') && !/^[A-Za-z]:/.test(value), 'contained relative file required');
export const atomicGraderSchema = z.strictObject({
  schema: z.literal('paideia.atomic-grader.v1'), id: identifier, templates: relativeFile,
  extractor: z.strictObject({ id: identifier.default('extractor'), provider: z.literal('codex'),
    model: z.string().min(1), effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
    deadline_ms: z.number().int().positive().max(2_147_483_647).default(900_000) }),
  decision: z.strictObject({ backend: z.literal('typesafe'), model: z.string().regex(/^jev-\d+\.\d+\.\d+$/),
    max_spend_usd: z.number().finite().nonnegative(), price_per_mtok_usd: z.number().finite().positive().default(0.042) }),
  missing: z.enum(['fail', 'unknown']),
  gates: z.array(z.strictObject({ id: identifier, check: z.record(z.string(), z.unknown()) })).default([]),
  aggregation: z.strictObject({ method: z.literal('gates-times-coverage-times-quality'),
    critical_pass_at: probability, pass_at: probability,
    obligation_kinds: z.array(identifier).min(1),
    dimensions: z.record(identifier, z.strictObject({ weight: z.number().finite().positive(), budget: z.number().finite().positive() })),
    penalties: z.strictObject({ critical: z.number().finite().positive(), major: z.number().finite().positive(), minor: z.number().finite().positive() }),
  }),
  feedback: z.strictObject({ max_checks: z.number().int().positive().max(1000).default(20),
    max_unit_chars: z.number().int().positive().max(10_000).default(300),
    max_bytes: z.number().int().min(512).max(100_000).default(8000), failure_threshold: probability.default(0.8),
  }).prefault({}),
});
export type AtomicGrader = z.infer<typeof atomicGraderSchema>;
export function parseAtomicGrader(value: unknown): AtomicGrader {
  const grader = parseSchema(atomicGraderSchema, value);
  if (new Set(grader.gates.map(gate => gate.id)).size !== grader.gates.length) throw new Error('duplicate atomic gate id');
  if (new Set(grader.aggregation.obligation_kinds).size !== grader.aggregation.obligation_kinds.length) throw new Error('duplicate obligation kind');
  if (!Object.keys(grader.aggregation.dimensions).length) throw new Error('atomic dimensions must not be empty');
  grader.gates.forEach(gate => checkBinding(gate.check, `gates.${gate.id}`));
  return grader;
}
export function parseAtomicGraderYaml(source: string): AtomicGrader { return parseAtomicGrader(parseYaml(source)); }
export function validateAtomicTemplates(grader: AtomicGrader, templates: CheckTemplates): void {
  for (const template of templates.templates) {
    const maxOptions = template.type === 'score' ? 10 : template.type === 'noul' ? 2 : 255;
    if (Object.keys(template.criteria).length > maxOptions) {
      throw new Error(`${template.id}: TypeSafe ${template.type} permits at most ${maxOptions} options`);
    }
    if (!Object.hasOwn(grader.aggregation.dimensions, template.dimension)) throw new Error(`undeclared dimension ${template.dimension}`);
  }
  for (const kind of grader.aggregation.obligation_kinds) {
    if (!templates.templates.some(template => template.applies_to === kind)) throw new Error(`ungraded obligation kind ${kind}`);
  }
}
