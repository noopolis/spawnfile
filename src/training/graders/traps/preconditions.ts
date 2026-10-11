import { normalizeWhitespace, textLeaves } from '../decomposition/index.js';
import type { CheckTemplates } from '../decomposition/index.js';

export function numbers(text: string): string[] { return text.match(/(?<![\p{L}\p{N}])\d+(?:[,.]\d+)*(?![\p{L}\p{N}])/gu) ?? []; }
export function numeric(value: string): string { return value.replaceAll(',', ''); }
export function plausibleNumber(before: string, after: string): boolean {
  const a = numeric(before), b = numeric(after);
  return /^\d+(?:\.\d+)?$/.test(a) && /^\d+(?:\.\d+)?$/.test(b) &&
    a.replace('.', '').length === b.replace('.', '').length && a.split('.')[1]?.length === b.split('.')[1]?.length &&
    Number(a) !== Number(b) && Number(a) > 0 && Math.abs(Number(a) - Number(b)) / Number(a) <= 0.2;
}
/** Only surface forms that independently identify a type are eligible. Bare names are ambiguous. */
export function entityType(value: string): string | undefined {
  if (/^(?:Dr|Mr|Mrs|Ms|Professor)\.?\s+[\p{Lu}][\p{L}-]+(?:\s+[\p{Lu}][\p{L}-]+)*$/u.test(value)) return 'person';
  if (/^[\p{Lu}][\p{L} -]+\s+(?:Inc|Ltd|LLC|Corporation)\.?$/u.test(value)) return 'organization';
  return undefined;
}
export function articleEntities(output: unknown): string[] {
  return textLeaves(output).flatMap(leaf => leaf.text.match(/\b(?:Dr|Mr|Mrs|Ms|Professor)\.?\s+[\p{Lu}][\p{L}-]+(?:\s+[\p{Lu}][\p{L}-]+)*|\b[\p{Lu}][\p{L}-]+(?:\s+[\p{Lu}][\p{L}-]+)*\s+(?:Inc|Ltd|LLC|Corporation)\.?/gu) ?? []);
}
export function withoutCitations(text: string, templates: CheckTemplates): string {
  for (const declaration of Object.values(templates.context)) {
    if (declaration.rows) text = text.replace(new RegExp(declaration.rows.cite, 'gm'), '');
  }
  return normalizeWhitespace(text).replace(/\s+([.!?])/g, '$1');
}
export const negator = /\b(?:not|no|never|neither|nor|without)\b|n['’]t\b/i;
export function affirmativeCounterpart(claim: string, cited: string, templates: CheckTemplates): boolean {
  const plain = withoutCitations(claim, templates).replace(/[.!?]$/, '');
  if (!plain || negator.test(plain)) return false;
  const escaped = plain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const declaration of Object.values(templates.context)) {
    if (declaration.rows) cited = cited.replace(new RegExp(declaration.rows.heading, 'gm'), '');
  }
  return new RegExp(`(?:^|[.!?]\\s+)${escaped}(?:[.!?](?:\\s|$)|$)`, 'u').test(normalizeWhitespace(cited));
}
