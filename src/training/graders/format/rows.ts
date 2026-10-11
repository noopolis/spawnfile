import { z } from 'zod';
import type { Grader } from './grader.js';

/** The empty alternative exposes the engine's capture count without parsing regex syntax. */
const rowRegex = z.string().max(200).superRefine((source, context) => {
  try {
    new RegExp(source, 'm');
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
