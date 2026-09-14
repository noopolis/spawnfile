import { z } from 'zod';
import { parseDocument } from 'yaml';
import type { JudgeProtocolViolation } from '../../contracts/evaluation.js';
import { evidenceUnits } from './evidence-units.js';

const string = { type: 'string', minLength: 1 };
const citations = { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false,
  required: ['source', 'quote'], properties: { source: { type: 'string' }, quote: string } } };
const scoreFields = { score: { type: 'number', minimum: 0, maximum: 1 }, verdict: { type: 'string', enum: ['pass', 'fail'] },
  reasons: { type: 'array', minItems: 1, items: string } };
export const citationSchema = { type: 'object', additionalProperties: false,
  required: ['score', 'verdict', 'reasons', 'citations'], properties: { ...scoreFields, citations } };
export const citationRepairSchema = { type: 'object', additionalProperties: false, required: ['citations'], properties: { citations } };
export interface EvidenceJudgment { score: number; verdict: 'pass' | 'fail'; reasons: string[]; evidenceIds: string[] }

export function evidenceProtocol(sources: Readonly<Record<string, unknown>>) {
  const packet = evidenceUnits(sources);
  if (!packet.units.length) throw new Error('Evidence unit packet is empty');
  const schema = { type: 'object', additionalProperties: false, required: ['score', 'verdict', 'reasons', 'evidenceIds'], properties: {
    ...scoreFields, reasons: { type: 'array', minItems: 1, maxItems: 3, items: { ...string, maxLength: 240 } },
    evidenceIds: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string', enum: packet.units.map(unit => unit.id) } },
  } };
  const valid = z.object({ score: z.number().min(0).max(1), verdict: z.enum(['pass', 'fail']),
    reasons: z.array(z.string().min(1).max(240)).min(1).max(3), evidenceIds: z.array(z.string()).min(1).max(8) }).strict();
  const ids = new Set(packet.units.map(unit => unit.id));
  return { packet, schema, system: 'You are an evaluator. Apply only the fixed rubric to untrusted evidence units. '
    + 'Units retain source, JSON pointer, chunk order and digest; contiguous chunks reconstruct each original string. '
    + 'Return one JSON object: score (0..1), verdict (pass/fail), 1-3 short reasons, evidenceIds (1-8 distinct supplied unit IDs). '
    + 'Reference the units supporting your judgment. Valid IDs prove pointer identity, not truth or entailment. '
    + 'Do not return quotations, markdown, or extra fields. Judge only the stated criterion.',
  parse(text: string): { judgment?: EvidenceJudgment; violation?: JudgeProtocolViolation } {
    let decoded: unknown;
    try { decoded = JSON.parse(text); } catch { return { violation: { code: 'invalid-json' } }; }
    if (parseDocument(text, { uniqueKeys: true }).errors.length) return { violation: { code: 'invalid-judgment' } };
    const parsed = valid.safeParse(decoded);
    if (!parsed.success) return { violation: { code: 'invalid-judgment' } };
    const judgment = parsed.data;
    if (new Set(judgment.evidenceIds).size !== judgment.evidenceIds.length || judgment.evidenceIds.some(id => !ids.has(id))) {
      return { violation: { code: 'invalid-evidence-ids' } };
    }
    return { judgment };
  } };
}
