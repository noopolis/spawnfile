import { moveLeadingCitations } from '../format/index.js';
import type { AtomicUnit, CheckTemplates } from './format.js';
import { normalizeWhitespace } from './spans.js';

/** Bind metadata to an observed span, never to an extractor's assertion. */
export function citationMetadataReasons(unit: AtomicUnit, sources: string[], templates?: CheckTemplates): string[] {
  const structures = Object.values(templates?.context ?? {}).flatMap(context => context.rows ? [context.rows] : []);
  const patterns = structures.length ? structures.map(rows => rows.cite) : ['\\[([A-Za-z0-9_-]+)\\]'];
  const previous = structures.filter(rows => rows.leading_citations === 'previous').map(rows => rows.cite);
  const citations = (text: string) => [...new Set(patterns.flatMap(pattern =>
    [...text.matchAll(new RegExp(pattern, 'gm'))].map(match => match[1] ?? '')))].sort();
  const supplied = [...(unit.cites ?? [])].sort();
  const matches = (text: string) => JSON.stringify(citations(text)) === JSON.stringify(supplied);
  const normalized = normalizeWhitespace(unit.text);
  const direct = citations(unit.text);
  const sentences = sources.flatMap(source => {
    const segments = Array.from(new Intl.Segmenter('en', { granularity: 'sentence' }).segment(source), item => item.segment.trim()).filter(Boolean);
    const adjusted = moveLeadingCitations(segments, previous);
    return unit.sentence === undefined ? adjusted : adjusted.slice(unit.sentence, unit.sentence + 1);
  }).filter(sentence => normalizeWhitespace(sentence).includes(normalized));
  const reasons: string[] = [];
  if (unit.sentence !== undefined && !sentences.length) reasons.push('sentence does not contain span');
  // An explicit citation in the unit is authoritative; otherwise bind the whole
  // containing sentence. Ambiguous repeated spans must agree at every location.
  if (direct.length ? !matches(unit.text) : sentences.length ? sentences.some(sentence => !matches(sentence)) : supplied.length > 0) {
    reasons.push('cites do not match source citations');
  }
  return reasons;
}

export interface DroppedField { id: string; field: string; value: string; reason: string }
export function dropUnboundFields(unit: AtomicUnit): DroppedField[] {
  const dropped: DroppedField[] = [];
  for (const [field, value] of Object.entries(unit.fields ?? {})) {
    if (value === undefined) continue;
    if (!normalizeWhitespace(value) || !normalizeWhitespace(unit.text).includes(normalizeWhitespace(value))) {
      dropped.push({ id: unit.id, field, value, reason: 'field value is not a verbatim unit span' });
      delete unit.fields![field as keyof NonNullable<AtomicUnit['fields']>];
    }
  }
  return dropped;
}
