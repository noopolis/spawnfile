import type { Grader } from './format/index.js';

type RowStructure = NonNullable<Grader['context'][string]['rows']>;
interface Row { id: string; text: string }
export interface CitedResolution { value?: Row[]; missing?: string; notApplicable?: boolean }

/** Keep whole heading lines and exact row bytes; preamble never enters a row. */
export function citedRows(source: unknown, unit: string, structure: RowStructure): CitedResolution {
  if (typeof source !== 'string') return { missing: 'row context must be a string' };
  const heading = new RegExp(structure.heading, 'm');
  const rows: Row[] = [];
  const ids = new Set<string>();
  for (const line of source.split(/(?<=\n)/u)) {
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
