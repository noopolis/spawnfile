import { stableDigest, sha256 } from '../format/index.js';
import { instantiateChecks, normalizeWhitespace, trapKinds, validateDecomposition } from '../decomposition/index.js';
import type { AtomicUnit, CheckTemplates, Decomposition, DecompositionInputs, TrapKind } from '../decomposition/index.js';
import { mutationFor, replaceLeaf, replaceNumber } from './mutations.js';
import { validateTrap } from './validation.js';
import type { Trap, TrapSet } from './types.js';

function variantDocument(document: Decomposition, unit: AtomicUnit, kind: TrapKind, source: string, replacement: string,
  before?: string, after?: string): Decomposition {
  if (kind === 'injected-redundancy' || kind === 'option-permutation') return structuredClone(document);
  function transform(item: AtomicUnit): AtomicUnit {
    const text = normalizeWhitespace(item.text).replace(normalizeWhitespace(source), normalizeWhitespace(replacement));
    const cites = kind === 'citation-swap' && item.cites && (item.id === unit.id || text !== normalizeWhitespace(item.text))
      ? item.cites.map(id => id === before ? after! : id) : item.cites;
    const changed = text !== normalizeWhitespace(item.text);
    const fields = changed && before && after && item.fields ? Object.fromEntries(Object.entries(item.fields)
      .map(([key, value]) => [key, kind === 'number-substitution' ? replaceNumber(value!, before, after) : value?.replaceAll(before, after)])) : item.fields;
    const source_span = changed ? undefined : item.source_span;
    const { source_span: _span, ...rest } = item;
    return { ...rest, text, ...(cites ? { cites } : {}), ...(fields ? { fields } : {}),
      ...(source_span === undefined ? {} : { source_span }) };
  }
  return { ...document, units: document.units.map(transform), ...(document.audit
    ? { audit: { ...document.audit, missed: document.audit.missed.map(transform) } } : {}) };
}
export function generateTraps(templates: CheckTemplates, document: Decomposition, inputs: DecompositionInputs,
  options: { seed?: string | number; baseFinals?: Record<string, string | null> } = {}): TrapSet {
  const seed = String(options.seed ?? '0');
  const result: TrapSet = { schema: 'paideia.traps.v1', seed, traps: [], discarded: 0, rejections: [] };
  const base = validateDecomposition(document, inputs, templates);
  if (base.rejected.length) throw new Error(`invalid base decomposition: ${base.rejected.map(item => item.id).join(', ')}`);
  document = base.decomposition;
  const baseInstances = instantiateChecks(templates, document, inputs);
  const units = [...document.units, ...(document.audit?.missed ?? [])];
  for (const unit of units) for (const kind of trapKinds) {
    const configured = templates.templates.filter(template => template.applies_to === unit.kind && template.traps?.[kind] !== undefined);
    if (!configured.length) continue;
    const selected = baseInstances.filter(instance => instance.unit_id === unit.id && instance.status === 'ready' && configured.some(template => template.id === instance.template_id));
    const discard = (reason: string): void => {
      result.discarded++; result.rejections.push({ kind, unit: unit.id, reason });
    };
    if (!['format-paraphrase', 'option-permutation'].includes(kind) && selected.some(instance =>
      !instance.expected.includes(options.baseFinals?.[instance.id] ?? ''))) { discard('baseline final is not an expected good answer'); continue; }
    if (!selected.length) { discard('no ready affected checks'); continue; }
    try {
      const permutation = kind === 'option-permutation';
      const mutation = permutation ? { path: [], source: unit.text, replacement: unit.text,
        before: JSON.stringify(selected.map(instance => instance.options)), after: JSON.stringify(selected.map(instance => [...instance.options].reverse())) }
        : mutationFor(kind, unit, document, inputs, templates, seed);
      if (!mutation) { discard('no unambiguous eligible mutation'); continue; }
      const output = permutation ? structuredClone(inputs.output) : replaceLeaf(inputs.output, mutation.path, mutation.after);
      let decomposition = variantDocument(document, unit, kind, mutation.source, mutation.replacement,
        mutation.value_before, mutation.value_after);
      decomposition.output = { from: 'embedded-output.json', sha256: sha256(JSON.stringify(output)) };
      const invalid = validateDecomposition(decomposition, { ...inputs, output }, templates);
      if (invalid.rejected.length) { discard('mutation invalidated another extracted span'); continue; }
      decomposition = invalid.decomposition;
      let instances = instantiateChecks(templates, decomposition, { ...inputs, output });
      const intended_answers = Object.fromEntries(selected.map(instance => [instance.id,
        configured.find(template => template.id === instance.template_id)!.traps![kind]!]));
      if (permutation) instances = instances.map(instance => {
        if (!Object.hasOwn(intended_answers, instance.id)) return instance;
        const options = [...instance.options].reverse();
        return { ...instance, options, digest: stableDigest({ original: instance.digest, options }) };
      });
      const trap: Trap = { id: stableDigest({ seed, kind, unit: unit.id, mutation, document, templates }), kind,
        base_unit: unit.id, mutation, affected_template_ids: selected.map(instance => instance.template_id), intended_answers,
        output, decomposition, instances, context_digest: stableDigest(inputs.context), validation: { valid: false, reasons: [] } };
      trap.validation = validateTrap(trap, unit, inputs, templates, document);
      if (!trap.validation.valid) { discard(trap.validation.reasons.join('; ')); continue; }
      if (instances.some(instance => Object.hasOwn(intended_answers, instance.id) && instance.status !== 'ready')) {
        discard('affected check became missing'); continue;
      }
      result.traps.push(trap);
    } catch (error) { discard((error as Error).message); }
  }
  return result;
}
