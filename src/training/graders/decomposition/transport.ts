import { z } from 'zod';
import { parseSchema, parseYaml } from '../format/index.js';
import { unitSchema } from './format.js';

const extractionSchema = z.strictObject({ units: z.array(unitSchema) });
export const extractionResponseSchema = z.toJSONSchema(extractionSchema, { target: 'draft-7' });

/** Only a single surrounding json fence is transport decoration. */
export function parseExtractionResponse(text: string) {
  const stripped = text.trim();
  const fenced = /^```json\r?\n([\s\S]*)\r?\n```$/u.exec(stripped);
  const json = fenced?.[1] ?? stripped;
  JSON.parse(json); // Require JSON syntax before the duplicate-key-aware parser.
  return parseSchema(extractionSchema, parseYaml(json));
}
