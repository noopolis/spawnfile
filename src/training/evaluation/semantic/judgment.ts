import { z } from 'zod';
import type { JudgeProtocolViolation } from '../../contracts/evaluation.js';
import { evidenceText } from '../selectors.js';

const citations = z.array(z.object({ source: z.string(), quote: z.string().min(1) }).strict()).min(1);
const judgment = z.object({ score: z.number().min(0).max(1), verdict: z.enum(['pass', 'fail']),
  reasons: z.array(z.string().min(1)).min(1), citations }).strict();
const repair = z.object({ citations }).strict();
export type Judgment = z.infer<typeof judgment>;

function containsStringLeaf(value: unknown, quote: string): boolean {
  if (typeof value === 'string') return value.includes(quote);
  if (value === null || typeof value !== 'object') return false;
  return Object.values(value).some(child => containsStringLeaf(child, quote));
}
function invalidCitations(values: Judgment['citations'], sources: Record<string, unknown>): JudgeProtocolViolation | undefined {
  const invalid: NonNullable<JudgeProtocolViolation['citations']> = [];
  for (const [index, { source, quote }] of values.entries()) {
    if (!Object.hasOwn(sources, source)) invalid.push({ index, source, reason: 'unknown-source' });
    else if (!evidenceText(sources[source]).includes(quote) && !containsStringLeaf(sources[source], quote)) {
      invalid.push({ index, source, reason: 'quote-not-found' });
    }
  }
  return invalid.length ? { code: 'invalid-citations', citations: invalid } : undefined;
}
export function parseJudgment(text: string, sources: Record<string, unknown>, original?: Judgment): {
  judgment?: Judgment; violation?: JudgeProtocolViolation;
} {
  let decoded: unknown;
  try { decoded = JSON.parse(text); } catch { return { violation: { code: 'invalid-json' } }; }
  if (original) {
    const parsed = repair.safeParse(decoded);
    if (!parsed.success) return { violation: { code: 'invalid-citation-repair' } };
    const value = { ...original, citations: parsed.data.citations };
    return { judgment: value, violation: invalidCitations(value.citations, sources) };
  }
  const parsed = judgment.safeParse(decoded);
  if (!parsed.success) return { violation: { code: 'invalid-judgment' } };
  return { judgment: parsed.data, violation: invalidCitations(parsed.data.citations, sources) };
}
export function violationReason(violation: JudgeProtocolViolation): string {
  if (violation.code === 'invalid-citations') return `Judge citation is not present in selected evidence (index ${violation.citations![0]!.index})`;
  return `Judge response violates protocol: ${violation.code}`;
}
