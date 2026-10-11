import { normalizeWhitespace, textLeaves } from '../decomposition/index.js';
import type { AtomicUnit, CheckTemplates } from '../decomposition/index.js';

export function numbers(text: string): string[] { return text.match(/(?<![\p{L}\p{N}])\d+(?:[,.]\d+)*(?![\p{L}\p{N}])/gu) ?? []; }
export function numeric(value: string): number { return Number(value.replaceAll(',', '')); }
export function plausibleNumber(before: string, after: string): boolean {
  const a = before.replaceAll(',', ''), b = after.replaceAll(',', '');
  return /^\d+(?:\.\d+)?$/.test(a) && /^\d+(?:\.\d+)?$/.test(b) &&
    a.replace('.', '').length === b.replace('.', '').length && a.split('.')[1]?.length === b.split('.')[1]?.length &&
    Number(a) !== Number(b) && Number(a) > 0 && Math.abs(Number(a) - Number(b)) / Number(a) <= 0.2;
}
/** Whole-unit lexical eligibility reduces bad diagnostics; it cannot establish quantity semantics. */
export function exactQuantities(unit: Pick<AtomicUnit, 'text' | 'fields'>): boolean {
  const qualifier = /\b(?:at\s+most|at\s+least|up\s+to|more\s+than|less\s+than|fewer|over|under|above|below|about|around|roughly|nearly|almost|approximately|some|or\s+so|plus|minimum|maximum)\b|[~><≥≤]/iu;
  const range = /\bbetween\b[\s\S]*\band\b|\bfrom\b[\s\S]*\bto\b|\d[\s\S]*(?:[-–—−]|\bto\b)[\s\S]*\d/iu;
  return [unit.text, ...Object.values(unit.fields ?? {})].every(text =>
    text === undefined || (!qualifier.test(text) && !range.test(text)));
}
/** Only surface forms that independently identify a type are eligible. Bare names are ambiguous. */
export function entityType(value: string): string | undefined {
  if (/^(?:Dr|Mr|Mrs|Ms|Prof|Professor)\.?\s+[\p{Lu}][\p{L}-]+(?:\s+[\p{Lu}][\p{L}-]+)*$/u.test(value)) return 'person';
  if (/^[\p{Lu}][\p{L} -]+\s+(?:Corporation|Inc|Ltd|Corp|Co|LLC)\.?$/u.test(value)) return 'organization';
  return undefined;
}
export function articleEntities(output: unknown): string[] {
  return textLeaves(output).flatMap(leaf => leaf.text.match(/\b(?:Dr|Mr|Mrs|Ms|Prof|Professor)\.?\s+[\p{Lu}][\p{L}-]+(?:\s+[\p{Lu}][\p{L}-]+)*|\b[\p{Lu}][\p{L}-]+(?:\s+[\p{Lu}][\p{L}-]+)*\s+(?:Corporation|Inc|Ltd|Corp|Co|LLC)\b\.?/gu) ?? []);
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

/** Preserve offsets so edits cannot land inside citation tokens. */
export function maskCitations(text: string, templates: CheckTemplates): string {
  for (const declaration of Object.values(templates.context)) {
    if (declaration.rows) text = text.replace(new RegExp(declaration.rows.cite, 'gm'), match => ' '.repeat(match.length));
  }
  return text;
}
export function withoutHeadings(text: string, templates: CheckTemplates): string {
  for (const declaration of Object.values(templates.context)) {
    if (declaration.rows) text = text.split(/\r\n|[\r\n\u2028\u2029]/u).filter(line => !new RegExp(declaration.rows!.heading, 'm').test(line)).join('\n');
  }
  return text;
}
export function coReferent(before: string, after: string): boolean {
  const stem = (value: string) => value.toLowerCase().replace(/\b(?:dr|mr|mrs|ms|prof|professor|inc|ltd|corp|corporation|co|llc)\b\.?/g, '').trim().replace(/\s+/g, ' ');
  const a = stem(before), b = stem(after);
  return !a || !b || a.includes(b) || b.includes(a) || a.split(' ')[0] === b.split(' ')[0];
}
/** Conservative surface grammar: ambiguity means no known-answer negation. */
export function negationAuxiliary(text: string): RegExpMatchArray | undefined {
  const candidates = [...text.matchAll(/\b(is|are|was|were|will|can|has|have|had|does|did)\b/gi)];
  if (negator.test(text) || candidates.length !== 1) return undefined;
  const match = candidates[0]!;
  const clause = text.slice(0, match.index);
  if (/\b(who|which|that|when|because|although|if)\b/i.test(clause)) return undefined;
  if (/^(has|have|had)$/i.test(match[0]) && !/^\s+(?:worked|reported|hired|promoted|launched|signed|opened|closed|acquired|increased|decreased|completed|announced|approved|rejected|changed|moved|received|produced|paid|been|done|gone|seen|taken|given|written|built|bought|brought|paid|made|sold|said|found|left|held|sent|won|lost|run|read)\b/i.test(text.slice(match.index + match[0].length))) return undefined;
  return match;
}
