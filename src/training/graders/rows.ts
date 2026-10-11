import type { Grader } from './format/index.js';

type RowStructure = NonNullable<Grader['context'][string]['rows']>;
interface Row { id: string; text: string }
export interface CitedResolution { value?: Row[]; missing?: string; notApplicable?: boolean }

/** One paragraph at a time; never create empty units from citation-only tails. */
export function moveLeadingCitations(sentences: string[], patterns: string[]): string[] {
  const citations = patterns.map(pattern => new RegExp(pattern, 'my'));
  const result: string[] = [];
  for (const sentence of sentences) {
    let end = 0;
    if (result.length) {
      let start = 0;
      while (start < sentence.length) {
        let length = 0;
        for (const citation of citations) {
          citation.lastIndex = start;
          length = Math.max(length, citation.exec(sentence)?.[0].length ?? 0);
        }
        // Zero-width matches are not tokens and must not prevent termination.
        if (!length) break;
        end = start + length;
        start = end + /^\s*/u.exec(sentence.slice(end))![0].length;
      }
    }
    if (end) result[result.length - 1] += ` ${sentence.slice(0, end)}`;
    const remaining = sentence.slice(end).trim();
    if (remaining) result.push(remaining);
  }
  return result;
}

/** Keep whole heading lines and exact row bytes; preamble never enters a row. */
export function citedRows(source: unknown, unit: string, structure: RowStructure): CitedResolution {
  if (typeof source !== 'string') return { missing: 'row context must be a string' };
  if (source.length > 2_000_000) return { missing: 'row context exceeds 2000000 characters' };
  const heading = new RegExp(structure.heading, 'm');
  const rows: Row[] = [];
  const ids = new Set<string>();
  for (const line of source.split(/(?<=\n|[\u2028\u2029])|(?<=\r)(?!\n)/u)) {
    const match = heading.exec(line);
    if (match) {
      const id = match[1];
      if (!id) return { missing: 'row heading has no row id' };
      if (ids.has(id)) return { missing: `duplicate row id ${id}` };
      ids.add(id);
      rows.push({ id, text: line });
    } else if (rows.length) rows.at(-1)!.text += line;
  }
  const cited = new Set<string>();
  for (const match of unit.matchAll(new RegExp(structure.cite, 'gm'))) {
    if (!match[1]) return { missing: 'citation has no row id' };
    cited.add(match[1]);
  }
  if (!cited.size) return { value: [], notApplicable: true };
  const unknown = [...cited].filter(id => !ids.has(id));
  if (unknown.length) return { missing: `unknown cited row id: ${unknown.join(', ')}` };
  // Context order is stable even when citations repeat or appear in another order.
  return { value: rows.filter(row => cited.has(row.id)) };
}
