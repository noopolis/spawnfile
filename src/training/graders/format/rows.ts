import { z } from 'zod';

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
export const rowsSchema = z.strictObject({ heading: rowRegex, cite: rowRegex });
