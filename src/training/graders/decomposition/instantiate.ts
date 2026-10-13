import { stableDigest } from '../format/index.js';
import type { AtomicSpan, AtomicUnit, CheckTemplate, CheckTemplates, Decomposition, DecompositionInputs } from './format.js';
import { evidenceRows, readPath, validateDecomposition } from './evidence.js';

export interface CheckInstance {
  id: string; template_id: string; unit_id: string; type: CheckTemplate['type'];
  instructions: string; criteria: Record<string, string>; options: string[]; expected: string[];
  projection: Record<string, unknown>; digest: string; status: 'ready' | 'missing'; reasons: string[];
}
function resolve(state: string, unit: AtomicUnit, inputs: DecompositionInputs, templates: CheckTemplates): unknown {
  if (state === 'unit') return unit;
  if (state === 'unit.pair') return unit.pair;
  if (state === 'unit.source_snapshots') return sourceSnapshots([unit], inputs, templates);
  if (state === 'unit.pair.source_snapshots') return unit.pair
    ? sourceSnapshots([unit.pair.left, unit.pair.right], inputs, templates) : undefined;
  if (state === 'unit.cited_rows') return citedRows(unit, inputs, templates);
  if (state === 'unit.pair.cited_rows') {
    if (!unit.pair) return undefined;
    const left = citedRows(unit.pair.left, inputs, templates), right = citedRows(unit.pair.right, inputs, templates);
    return left === undefined || right === undefined ? undefined : { left, right };
  }
  if (state.startsWith('output.')) return readPath(inputs.output, state.slice(7).split('.'));
  if (state.startsWith('context.')) return inputs.context[state.slice(8)];
  const body = readPath(inputs.output, ['body']);
  if (!Array.isArray(body) || unit.paragraph === undefined || typeof body[unit.paragraph] !== 'string') return undefined;
  if (state === 'paragraph') return body[unit.paragraph];
  return { previous: body[unit.paragraph - 1] ?? null, next: body[unit.paragraph + 1] ?? null };
}
function citedRows(span: AtomicSpan, inputs: DecompositionInputs, templates: CheckTemplates) {
  if (!Object.values(templates.context).some(item => item.rows)) return undefined;
  if (!span.cites?.length) return [];
  const rows = evidenceRows(templates, inputs);
  if (span.cites.some(id => !rows.some(row => row.id === id))) return undefined;
  return rows.filter(row => span.cites!.includes(row.id));
}
/** Caller-validated snapshots declare the evidence row IDs they cover; never infer coverage from presence alone. */
function sourceSnapshots(spans: AtomicSpan[], inputs: DecompositionInputs, templates: CheckTemplates) {
  const reads = spans.map(span => citedRows(span, inputs, templates));
  if (reads.some(rows => rows === undefined)) return undefined;
  const ids = [...new Set(reads.flatMap(rows => rows!.map(row => row.id)))];
  const snapshots = inputs.context.source_snapshots;
  if (!ids.length || !Array.isArray(snapshots)) return undefined;
  const selected = snapshots.filter((snapshot: unknown) => {
    if (!snapshot || typeof snapshot !== 'object') return false;
    const cites = (snapshot as { cites?: unknown }).cites;
    return Array.isArray(cites) && cites.some(id => ids.includes(id));
  }) as { cites: unknown[] }[];
  if (ids.some(id => !selected.some(snapshot => snapshot.cites.includes(id)))) return undefined;
  return selected;
}
/** Placeholders have the same declared-read boundary as the projection. */
function placeholder(path: string, projection: Record<string, unknown>): unknown {
  const prefix = Object.keys(projection).sort((a, b) => b.length - a.length).find(key => path === key || path.startsWith(`${key}.`));
  if (prefix === undefined) return undefined;
  return path === prefix ? projection[prefix] : readPath(projection[prefix], path.slice(prefix.length + 1).split('.'));
}
export interface InstantiationReport {
  checks: CheckInstance[];
  skipped: { template_id: string; unit_id: string; location: string; reason: string }[];
}
export function instantiateChecksReport(templates: CheckTemplates, document: Decomposition, inputs: DecompositionInputs): InstantiationReport {
  const validation = validateDecomposition(document, inputs, templates);
  const rejected = new Map(validation.rejected.map(item => [item.id, item.reasons]));
  const sanitized = new Map([...validation.decomposition.units, ...(validation.decomposition.audit?.missed ?? [])].map(unit => [unit.id, unit]));
  const rejectedPairs = new Map(validation.rejected.map(item => [item.id, item.unit.pair]));
  const units = [...document.units, ...(document.audit?.missed ?? [])].map(unit => sanitized.get(unit.id)
    ?? (unit.pair ? { ...unit, pair: rejectedPairs.get(unit.id) ?? unit.pair } : unit));
  const skipped: InstantiationReport['skipped'] = [];
  const checks = templates.templates.flatMap(template => units.filter(unit => unit.kind === template.applies_to).flatMap(unit => {
    if (!rejected.has(unit.id) && template.locations && !template.locations.includes(unit.location!)) {
      skipped.push({ template_id: template.id, unit_id: unit.id, location: unit.location!, reason: 'outside declared template locations' });
      return [];
    }
    const reasons = [...(rejected.get(unit.id) ?? [])];
    if (template.when) {
      const field = unit.fields?.[template.when.field];
      if (field === undefined) reasons.push(`missing condition field ${template.when.field}`);
      else if (field !== template.when.equals && !reasons.length) return [];
    }
    const projection: Record<string, unknown> = {};
    for (const state of template.state) {
      try {
        const value = resolve(state, unit, inputs, templates);
        if (value === undefined || value === null) reasons.push(`missing state ${state}`);
        else projection[state] = value;
      } catch (error) { reasons.push(`${state}: ${(error as Error).message}`); }
    }
    const instructions = template.instructions.replace(/\{([^{}]+)\}/g, (token, path: string) => {
      const value = placeholder(path, projection);
      if (value === undefined || value === null) { reasons.push(`missing placeholder ${path}`); return token; }
      return typeof value === 'string' ? value : JSON.stringify(value);
    });
    const instance = { id: `${template.id}@${unit.id}`, template_id: template.id, unit_id: unit.id,
      type: template.type, instructions, criteria: template.criteria, options: Object.keys(template.criteria),
      expected: template.expected, projection, status: reasons.length ? 'missing' as const : 'ready' as const, reasons };
    return [{ ...instance, digest: stableDigest({ template, instance }) }];
  }));
  for (const rejected of document.rejected ?? []) {
    const instance: Omit<CheckInstance, 'digest'> = { id: `rejected@${rejected.id}`, unit_id: rejected.id,
      template_id: 'rejected', type: 'choice', instructions: 'Rejected decomposition unit',
      criteria: { present: 'Validated', missing: 'Rejected' }, options: ['present', 'missing'], expected: ['present'],
      projection: {}, status: 'missing', reasons: rejected.reasons };
    checks.push({ ...instance, digest: stableDigest({ instance, rejected }) });
  }
  return { checks, skipped };
}
export function instantiateChecks(templates: CheckTemplates, document: Decomposition, inputs: DecompositionInputs): CheckInstance[] {
  return instantiateChecksReport(templates, document, inputs).checks;
}
