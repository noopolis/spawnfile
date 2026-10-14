import { moveLeadingCitations } from '../format/index.js';
import type { AtomicSpan, AtomicUnit, CheckTemplates, DecompositionInputs } from './format.js';
import { normalizeWhitespace, readPath, textLeaves } from './spans.js';

interface LocatedSpan { location: string; paragraph?: number; sentence?: number; offset: number; cites: string[] }
export interface CitationDisagreement { id: string; supplied: string[]; derived: string[] }

/** Whitespace-only offsets preserve citation ownership when tokens move between sentences. */
function width(text: string): number { return text.replace(/\s/gu, '').length; }

export function locateUnit(unit: AtomicUnit, inputs: DecompositionInputs, templates?: CheckTemplates): LocatedSpan | string {
  const sources = textLeaves(inputs.output);
  if ((inputs.obligationKinds ?? ['obligation']).includes(unit.kind)) {
    for (const [name, value] of Object.entries(inputs.context)) {
      if (name === 'assignment' || templates?.context[name]?.role === 'assignment') sources.push(...textLeaves(value, ['context', name]));
    }
  }
  return locateSpan(unit, sources, inputs, templates);
}

/** Relational endpoints must be observable output spans, including for obligations. */
export function locateOutputSpan(span: AtomicSpan, inputs: DecompositionInputs, templates?: CheckTemplates): LocatedSpan | string {
  return locateSpan(span, textLeaves(inputs.output), inputs, templates);
}

function locateSpan(unit: AtomicSpan, sources: ReturnType<typeof textLeaves>, inputs: DecompositionInputs,
  templates?: CheckTemplates): LocatedSpan | string {
  const structures = Object.values(templates?.context ?? {}).flatMap(context => context.rows ? [context.rows] : []);
  const patterns = structures.length ? structures.map(rows => rows.cite) : ['\\[([A-Za-z0-9_-]+)\\]'];
  const previous = structures.filter(rows => rows.leading_citations === 'previous').map(rows => rows.cite);
  const matches: LocatedSpan[] = [];
  const needle = normalizeWhitespace(unit.text);
  const pattern = needle.split(' ').map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  for (const source of sources) {
    const body = source.path.length === 2 && source.path[0] === 'body' && Array.isArray(readPath(inputs.output, ['body']));
    const sentences = body ? moveLeadingCitations(Array.from(new Intl.Segmenter('en', { granularity: 'sentence' })
      .segment(source.text), item => item.segment.trim()).filter(Boolean), previous) : [];
    // Lookahead retains overlapping occurrences; offsets address the original source string.
    for (const occurrence of source.text.matchAll(new RegExp(`(?=${pattern})`, 'gu'))) {
      const match: LocatedSpan = { location: body ? 'body' : source.path.join('.') || 'output', offset: occurrence.index, cites: [] };
      if (body) {
        match.paragraph = Number(source.path[1]);
        const from = width(source.text.slice(0, occurrence.index)), to = from + width(needle);
        let offset = 0;
        sentences.forEach((sentence, index) => {
          const end = offset + width(sentence);
          if (offset < to && end > from) {
            match.sentence ??= index;
            match.cites.push(...patterns.flatMap(pattern => [...sentence.matchAll(new RegExp(pattern, 'gm'))]
              .map(token => token[1] ?? '')));
          }
          offset = end;
        });
        match.cites = [...new Set(match.cites)].sort();
      }
      matches.push(match);
    }
  }
  if (!matches.length) return 'text is not a verbatim source span';
  if (matches.length === 1) return matches[0]!;
  const hintedBy = (location?: string) => matches.filter(match => (location === undefined || location === match.location)
    && (unit.paragraph === undefined || unit.paragraph === match.paragraph)
    && (unit.sentence === undefined || unit.sentence === match.sentence));
  // Extractors may address array leaves as `a[1].b`; a literal key match wins over the resolved `a.1.b` path.
  let hinted = hintedBy(unit.location);
  if (!hinted.length && unit.location) hinted = hintedBy(unit.location.replace(/\[(\d+)\]/gu, '.$1'));
  return hinted.length === 1 ? hinted[0]! : 'ambiguous source span';
}

export function bindLocation(unit: AtomicSpan & { id: string }, located: LocatedSpan): CitationDisagreement | undefined {
  const supplied = unit.cites;
  delete unit.paragraph;
  delete unit.sentence;
  const { offset: _offset, ...address } = located;
  Object.assign(unit, address);
  if (supplied && JSON.stringify([...supplied].sort()) !== JSON.stringify(located.cites)) {
    return { id: unit.id, supplied, derived: located.cites };
  }
  return undefined;
}
