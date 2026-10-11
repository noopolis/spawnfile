import { z } from 'zod';
import { identifier, parseSchema, parseYaml, rowsSchema } from '../format/index.js';

export const trapKinds = ['number-substitution', 'entity-substitution', 'negation-flip', 'citation-swap',
  'injected-redundancy', 'format-paraphrase', 'option-permutation'] as const;
export type TrapKind = typeof trapKinds[number];
const id = identifier.refine(value => !value.includes('@'), '@ is reserved for check IDs');
const reference = z.strictObject({ from: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export const unitSchema = z.strictObject({
  id, label: z.string().optional(), kind: identifier, text: z.string().refine(value => value.trim().length > 0, 'text must not be blank'),
  paragraph: z.number().int().nonnegative().optional(), sentence: z.number().int().nonnegative().optional(),
  location: z.string().min(1).optional(),
  cites: z.array(identifier).optional(),
  fields: z.strictObject(Object.fromEntries(['actor', 'action', 'object', 'time', 'modality', 'quantity']
    .map(key => [key, z.string().optional()])) as Record<'actor' | 'action' | 'object' | 'time' | 'modality' | 'quantity', z.ZodOptional<z.ZodString>>).optional(),
  source_span: z.string().optional(),
});
const extractor = z.strictObject({ provider: identifier, model: z.string().min(1),
  prompt_digest: z.string().regex(/^[a-f0-9]{64}$/), at: z.iso.datetime({ offset: true }) });
export const decompositionSchema = z.strictObject({
  schema: z.literal('paideia.decomposition.v1'), output: reference,
  context: z.record(identifier, reference).default({}), units: z.array(unitSchema),
  extractors: z.array(extractor).min(1),
  rejected: z.array(z.strictObject({ id, reasons: z.array(z.string()).min(1), unit: unitSchema })).optional(),
  audit: z.strictObject({ extractor, missed: z.array(unitSchema), at: z.iso.datetime({ offset: true }) }).optional(),
});
export type AtomicUnit = z.infer<typeof unitSchema>;
export type Decomposition = z.infer<typeof decompositionSchema>;
export interface DecompositionInputs { output: unknown; context: Record<string, unknown> }
const read = z.string().regex(/^(unit(?:\.cited_rows)?|paragraph|neighbors|output\.[\w.-]+|context\.[\w-]+)$/);
const answer = z.union([z.string(), z.number().int(), z.boolean()]).transform(String);
const templateSchema = z.strictObject({
  id, applies_to: identifier, type: z.enum(['noul', 'choice', 'score']), instructions: z.string().min(1),
  criteria: z.record(identifier, z.string().min(1)), expected: z.array(answer).min(1),
  state: z.array(read).min(1), dimension: identifier, severity: z.enum(['critical', 'major', 'minor']),
  when: z.strictObject({ field: z.enum(['actor', 'action', 'object', 'time', 'modality', 'quantity']),
    equals: z.string() }).optional(),
  locations: z.array(z.string().min(1)).min(1).optional(),
  traps: z.partialRecord(z.enum(trapKinds), z.union([answer,
    z.strictObject({ answer, known_answer: z.boolean() })])).optional(),
});
export const checkTemplatesSchema = z.strictObject({
  schema: z.literal('paideia.check-templates.v1'), templates: z.array(templateSchema).min(1),
  kinds: z.record(identifier, z.string().min(1)).optional(),
  context: z.record(identifier, z.strictObject({ rows: rowsSchema.optional(),
    role: z.literal('assignment').optional(), description: z.string().optional() })).default({}),
  teachers: z.array(z.strictObject({ id: identifier, provider: z.enum(['codex', 'claude', 'grok']),
    model: z.string().min(1), effort: z.string().min(1).optional() })).optional(),
  grok_window: z.strictObject({ start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), timeZone: z.literal('Europe/Berlin').optional() }).optional(),
});
export type CheckTemplates = z.infer<typeof checkTemplatesSchema>;
export type CheckTemplate = CheckTemplates['templates'][number];

export function trapDeclaration(value: NonNullable<NonNullable<CheckTemplate['traps']>[TrapKind]>): { answer: string; known_answer: boolean } {
  return typeof value === 'string' ? { answer: value, known_answer: true } : value;
}

export function parseDecomposition(value: unknown): Decomposition {
  const result = parseSchema(decompositionSchema, value);
  const ids = [...result.units, ...(result.audit?.missed ?? []), ...(result.rejected ?? []).map(item => item.unit)].map(unit => unit.id);
  if (result.rejected?.some(item => item.id !== item.unit.id)) throw new Error('rejected unit id mismatch');
  if (new Set(ids).size !== ids.length) throw new Error('duplicate unit id');
  return result;
}
export function parseCheckTemplates(value: unknown): CheckTemplates {
  const result = parseSchema(checkTemplatesSchema, value);
  if (new Set(result.templates.map(t => t.id)).size !== result.templates.length) throw new Error('duplicate template id');
  if (new Set(result.teachers?.map(t => t.id)).size !== (result.teachers?.length ?? 0)) throw new Error('duplicate teacher id');
  for (const template of result.templates) {
    const options = Object.keys(template.criteria);
    if (options.length < 2 || options.some(key => ['missing', 'abstain', 'uncertain', 'unchanged'].includes(key))) throw new Error(`${template.id}: invalid criteria`);
    if (template.type === 'noul' && (options.length !== 2 || !options.includes('true') || !options.includes('false'))) throw new Error(`${template.id}: noul criteria require true/false`);
    if (template.type === 'score' && options.some(key => !/^-?\d+$/.test(key))) throw new Error(`${template.id}: score criteria require integer keys`);
    if (new Set(template.expected).size !== template.expected.length || template.expected.some(key => !options.includes(key))) throw new Error(`${template.id}: invalid expected answer`);
    for (const [kind, value] of Object.entries(template.traps ?? {})) {
      const label = trapDeclaration(value).answer;
      const control = kind === 'format-paraphrase' || kind === 'option-permutation';
      if (control ? label !== 'unchanged' : !options.includes(label)) throw new Error(`${template.id}: invalid trap answer for ${kind}`);
    }
    for (const state of template.state) {
      if (state.startsWith('context.') && !Object.hasOwn(result.context, state.slice(8))) throw new Error(`${template.id}: undeclared context ${state}`);
    }
  }
  return result;
}
export function parseCheckTemplatesYaml(source: string): CheckTemplates { return parseCheckTemplates(parseYaml(source)); }
