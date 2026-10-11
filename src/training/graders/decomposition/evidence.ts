import type { AtomicUnit, CheckTemplates, Decomposition, DecompositionInputs } from './format.js';
import { parseDecomposition } from './format.js';
import { dropUnboundFields, type DroppedField } from './metadata.js';

import { locateUnit, bindLocation, type CitationDisagreement } from './location.js';
import { normalizeWhitespace } from './spans.js';
export { normalizeWhitespace, readPath, textLeaves } from './spans.js';
export interface EvidenceRow { id: string; text: string; context: string }
export function evidenceRows(templates: CheckTemplates, inputs: DecompositionInputs): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  const ids = new Set<string>();
  for (const [name, declaration] of Object.entries(templates.context)) {
    if (!declaration.rows) continue;
    const source = inputs.context[name];
    if (typeof source !== 'string' || source.length > 2_000_000) throw new Error(`missing or oversized row context ${name}`);
    const heading = new RegExp(declaration.rows.heading, 'm');
    let row: EvidenceRow | undefined;
    for (const line of source.split(/(?<=\n|[\u2028\u2029])|(?<=\r)(?!\n)/u)) {
      const match = heading.exec(line);
      if (match) {
        if (!match[1] || ids.has(match[1])) throw new Error(`missing or duplicate row id ${match[1] ?? ''}`);
        ids.add(match[1]);
        row = { id: match[1], text: line, context: name };
        rows.push(row);
      } else if (row) row.text += line;
    }
  }
  return rows;
}
export interface RejectedUnit { id: string; reasons: string[] }
export function validateDecomposition(value: unknown, inputs: DecompositionInputs, templates?: CheckTemplates): {
  decomposition: Decomposition; rejected: RejectedUnit[]; dropped: DroppedField[]; citationDisagreements: CitationDisagreement[];
} {
  const document = parseDecomposition(value);
  const rejected: RejectedUnit[] = [];
  const dropped: DroppedField[] = [];
  const citationDisagreements: CitationDisagreement[] = [];
  let rows: EvidenceRow[] = [];
  let rowError: string | undefined;
  if (templates) {
    try { rows = evidenceRows(templates, inputs); }
    catch (error) { rowError = (error as Error).message; }
  }
  const hasRows = templates && Object.values(templates.context).some(item => item.rows);
  function valid(unit: AtomicUnit): boolean {
    const reasons: string[] = [];
    const located = locateUnit(unit, inputs, templates);
    if (typeof located === 'string') reasons.push(located);
    else {
      const disagreement = bindLocation(unit, located);
      if (disagreement) citationDisagreements.push(disagreement);
    }
    if (templates && !templates.templates.some(template => template.applies_to === unit.kind) && !Object.hasOwn(templates.kinds ?? {}, unit.kind)) reasons.push(`undeclared unit kind ${unit.kind}`);
    if (hasRows && unit.cites?.length) {
      if (rowError) reasons.push(rowError);
      else if (unit.cites.some(id => !rows.some(row => row.id === id))) reasons.push('unknown cited row');
    }
    if (unit.source_span !== undefined && (!normalizeWhitespace(unit.source_span) || !rows.some(row =>
      unit.cites?.includes(row.id) && normalizeWhitespace(row.text).includes(normalizeWhitespace(unit.source_span!))))) {
      reasons.push('source_span is not a verbatim cited row span');
    }
    dropped.push(...dropUnboundFields(unit));
    if (reasons.length) rejected.push({ id: unit.id, reasons });
    return reasons.length === 0;
  }
  return { decomposition: { ...document, units: document.units.filter(valid),
    ...(document.audit ? { audit: { ...document.audit, missed: document.audit.missed.filter(valid) } } : {}) }, rejected, dropped, citationDisagreements };
}
