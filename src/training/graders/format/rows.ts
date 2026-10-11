import { z } from 'zod';
import type { Grader } from './grader.js';
import { rowRegexSafetyIssue } from './row-regex.js';

/** The empty alternative exposes the engine's capture count without parsing regex syntax. */
const rowRegex = z.string().max(200).superRefine((source, context) => {
  if (source.length > 200) return;
  try {
    new RegExp(source, 'm');
    const issue = rowRegexSafetyIssue(source);
    if (issue) {
      context.addIssue({ code: 'custom', message: issue });
      return;
    }
    if (new RegExp(`(?:${source})|`, 'm').exec('')!.length !== 2) {
      context.addIssue({ code: 'custom', message: 'requires exactly one capture group for the row id' });
    }
  } catch {
    context.addIssue({ code: 'custom', message: 'invalid row regex' });
  }
});
export const rowsSchema = z.strictObject({
  heading: rowRegex, cite: rowRegex,
  leading_citations: z.enum(['keep', 'previous']).default('keep'),
});

/** Shared by unit construction and identity, including sentence-only reads. */
export function sentenceCitationPolicy(grader: Grader) {
  const patterns = Object.values(grader.context).flatMap(({ rows }) =>
    rows?.leading_citations === 'previous' ? [rows.cite] : []);
  return { version: 'leading-citations.previous.v1', patterns };
}
