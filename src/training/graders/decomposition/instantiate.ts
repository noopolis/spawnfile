import { stableDigest } from '../format/index.js';
import type { AtomicUnit, CheckTemplate, CheckTemplates, Decomposition, DecompositionInputs } from './format.js';
import { evidenceRows, readPath, validateDecomposition } from './evidence.js';

export interface CheckInstance {
  id: string; template_id: string; unit_id: string; type: CheckTemplate['type'];
  instructions: string; criteria: Record<string, string>; options: string[]; expected: string[];
  projection: Record<string, unknown>; digest: string; status: 'ready' | 'missing'; reasons: string[];
}
function resolve(state: string, unit: AtomicUnit, inputs: DecompositionInputs, templates: CheckTemplates): unknown {
  if (state === 'unit') return unit;
  if (state === 'unit.cited_rows') {
    if (!unit.cites?.length || !Object.values(templates.context).some(item => item.rows)) return undefined;
    const rows = evidenceRows(templates, inputs);
    if (unit.cites.some(id => !rows.some(row => row.id === id))) return undefined;
    return rows.filter(row => unit.cites!.includes(row.id));
  }
  if (state.startsWith('output.')) return readPath(inputs.output, state.slice(7).split('.'));
  if (state.startsWith('context.')) return inputs.context[state.slice(8)];
  const body = readPath(inputs.output, ['body']);
  if (!Array.isArray(body) || unit.paragraph === undefined || typeof body[unit.paragraph] !== 'string') return undefined;
  if (state === 'paragraph') return body[unit.paragraph];
  return { previous: body[unit.paragraph - 1] ?? null, next: body[unit.paragraph + 1] ?? null };
}
/** Placeholders have the same declared-read boundary as the projection. */
function placeholder(path: string, projection: Record<string, unknown>): unknown {
  const prefix = Object.keys(projection).sort((a, b) => b.length - a.length).find(key => path === key || path.startsWith(`${key}.`));
  if (prefix === undefined) return undefined;
  return path === prefix ? projection[prefix] : readPath(projection[prefix], path.slice(prefix.length + 1).split('.'));
}
export function instantiateChecks(templates: CheckTemplates, document: Decomposition, inputs: DecompositionInputs): CheckInstance[] {
  const validation = validateDecomposition(document, inputs, templates);
  const rejected = new Map(validation.rejected.map(item => [item.id, item.reasons]));
  const sanitized = new Map([...validation.decomposition.units, ...(validation.decomposition.audit?.missed ?? [])].map(unit => [unit.id, unit]));
  const units = [...document.units, ...(document.audit?.missed ?? [])].map(unit => sanitized.get(unit.id) ?? unit);
  return templates.templates.flatMap(template => units.filter(unit => unit.kind === template.applies_to).flatMap(unit => {
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
}
