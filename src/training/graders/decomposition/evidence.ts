import type { AtomicUnit, CheckTemplates, Decomposition, DecompositionInputs } from './format.js';
import { parseDecomposition } from './format.js';

export function normalizeWhitespace(text: string): string { return text.replace(/\s+/gu, ' ').trim(); }
export function textLeaves(value: unknown, path: string[] = []): { path: string[]; text: string }[] {
  if (typeof value === 'string') return [{ path, text: value }];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, entry]) => textLeaves(entry, [...path, key]));
}
export function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
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
  decomposition: Decomposition; rejected: RejectedUnit[];
} {
  const document = parseDecomposition(value);
  const rejected: RejectedUnit[] = [];
  let rows: EvidenceRow[] = [];
  let rowError: string | undefined;
  if (templates) {
    try { rows = evidenceRows(templates, inputs); }
    catch (error) { rowError = (error as Error).message; }
  }
  const hasRows = templates && Object.values(templates.context).some(item => item.rows);
  function valid(unit: AtomicUnit): boolean {
    const reasons: string[] = [];
    const assignment = Object.entries(inputs.context).filter(([name]) => name === 'assignment' || templates?.context[name]?.role === 'assignment').map(([, value]) => value);
    const sources = unit.kind === 'obligation' ? [...textLeaves(inputs.output), ...assignment.flatMap(value => textLeaves(value))] : textLeaves(inputs.output);
    if (!sources.some(source => normalizeWhitespace(source.text).includes(normalizeWhitespace(unit.text)))) reasons.push('text is not a verbatim source span');
    if (unit.kind !== 'obligation' && unit.paragraph !== undefined) {
      const paragraph = readPath(inputs.output, ['body', String(unit.paragraph)]);
      if (typeof paragraph !== 'string' || !normalizeWhitespace(paragraph).includes(normalizeWhitespace(unit.text))) reasons.push('paragraph does not contain span');
    }
    if (templates && !templates.templates.some(template => template.applies_to === unit.kind)) reasons.push(`undeclared unit kind ${unit.kind}`);
    if (hasRows && unit.cites?.length) {
      if (rowError) reasons.push(rowError);
      else if (unit.cites.some(id => !rows.some(row => row.id === id))) reasons.push('unknown cited row');
    }
    if (unit.cites && new Set(unit.cites).size !== unit.cites.length) reasons.push('duplicate cited row');
    if (reasons.length) rejected.push({ id: unit.id, reasons });
    return reasons.length === 0;
  }
  return { decomposition: { ...document, units: document.units.filter(valid),
    ...(document.audit ? { audit: { ...document.audit, missed: document.audit.missed.filter(valid) } } : {}) }, rejected };
}
