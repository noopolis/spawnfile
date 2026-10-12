import { stableDigest } from '../format/index.js';
import { trapKinds, instantiateChecks, trapDeclaration, normalizeWhitespace, readPath, textLeaves, validateDecomposition } from '../decomposition/index.js';
import type { AtomicUnit, CheckTemplates, Decomposition, DecompositionInputs } from '../decomposition/index.js';
import type { Trap } from './types.js';
import { formatParaphrase, replaceLeaf } from './mutations.js';


/** Separate from candidate construction: validate the actual serialized variant. */
export function validateTrap(trap: Trap, unit: AtomicUnit, inputs: DecompositionInputs, templates: CheckTemplates, baseDocument?: Decomposition): Trap['validation'] {
  if (!(trapKinds as readonly string[]).includes(trap.kind)) return { valid: false, reasons: ['unsupported trap kind: non-entailment cannot be proven'] };
  const reasons: string[] = [];
  if (baseDocument) {
    const base = validateDecomposition(baseDocument, inputs, templates);
    if (base.rejected.length) reasons.push('invalid base decomposition');
    baseDocument = base.decomposition;
    unit = [...baseDocument.units, ...(baseDocument.audit?.missed ?? [])].find(item => item.id === unit.id) ?? unit;
  }
  const { mutation: mutation, kind } = trap;
  const variant = validateDecomposition(trap.decomposition, { ...inputs, output: trap.output }, templates);
  if (variant.rejected.length) reasons.push('invalid variant decomposition');
  const storedUnits = [...trap.decomposition.units, ...(trap.decomposition.audit?.missed ?? [])];
  for (const located of [...variant.decomposition.units, ...(variant.decomposition.audit?.missed ?? [])]) {
    const stored = storedUnits.find(item => item.id === located.id)!;
    if (stableDigest(stored.cites ?? []) !== stableDigest(located.cites)) reasons.push('variant citations differ from source');
  }
  const rendered = instantiateChecks(templates, trap.decomposition, { ...inputs, output: trap.output });
  if (kind === 'option-permutation') for (const instance of rendered) {
    if (!Object.hasOwn(trap.intended_answers, instance.id)) continue;
    const options = [...instance.options].reverse();
    instance.digest = stableDigest({ original: instance.digest, options }); instance.options = options;
  }
  if (stableDigest(rendered) !== stableDigest(trap.instances)) reasons.push('instances differ from rendered variant');
  const configured = templates.templates.filter(template => template.applies_to === unit.kind && template.traps?.[kind] !== undefined);
  const baseInstances = baseDocument ? instantiateChecks(templates, baseDocument, inputs) : undefined;
  const selected = (baseInstances ?? rendered).filter(instance => instance.unit_id === unit.id && instance.status === 'ready' &&
    configured.some(template => template.id === instance.template_id));
  const intended = Object.fromEntries(selected.map(instance => [instance.id, trapDeclaration(configured.find(template => template.id === instance.template_id)!.traps![kind]!).answer]));
  if (!selected.length || stableDigest(intended) !== stableDigest(trap.intended_answers) ||
    stableDigest(selected.map(instance => instance.template_id)) !== stableDigest(trap.affected_template_ids)) reasons.push('invalid affected checks or intended answers');
  if (baseDocument) {
    const baseUnits = [...baseDocument.units, ...(baseDocument.audit?.missed ?? [])];
    const variantUnits = [...trap.decomposition.units, ...(trap.decomposition.audit?.missed ?? [])];
    if (baseUnits.length !== variantUnits.length || baseUnits.some((base, i) => base.id !== variantUnits[i]?.id || base.kind !== variantUnits[i]?.kind)) reasons.push('variant changed unit population');
    for (const [i, base] of baseUnits.entries()) {
      const changed = variantUnits[i];
      if (!changed) continue;
      const expectedText = ['option-permutation', 'injected-redundancy'].includes(kind) ? base.text :
        normalizeWhitespace(base.text).replace(normalizeWhitespace(mutation.source), normalizeWhitespace(mutation.replacement));
      if (normalizeWhitespace(changed.text) !== normalizeWhitespace(expectedText) || changed.paragraph !== base.paragraph ||
        changed.sentence !== base.sentence || changed.location !== base.location) reasons.push('variant changed unrelated unit state');
      const textChanged = normalizeWhitespace(expectedText) !== normalizeWhitespace(base.text);
      const expectedFields = Object.fromEntries(Object.entries(base.fields ?? {}).flatMap(([key, value]) => {
        if (value === undefined) return [];
        const expected = value;
        return normalizeWhitespace(expected) && normalizeWhitespace(expectedText).includes(normalizeWhitespace(expected)) ? [[key, expected]] : [];
      }));
      if (stableDigest(changed.fields ?? {}) !== stableDigest(expectedFields) ||
        changed.source_span !== (textChanged ? undefined : base.source_span)) reasons.push('variant changed unrelated extraction metadata');
    }
  }
  if (trap.context_digest !== stableDigest(inputs.context)) reasons.push('evidence changed');
  if (kind === 'option-permutation') {
    if (stableDigest(trap.output) !== stableDigest(inputs.output)) reasons.push('permutation changed output');
    if (mutation.before === mutation.after) reasons.push('options did not permute');
    for (const instance of trap.instances) {
      const template = templates.templates.find(item => item.id === instance.template_id)!;
      const options = Object.keys(template.criteria);
      if (Object.hasOwn(trap.intended_answers, instance.id)) options.reverse();
      if (stableDigest(instance.options) !== stableDigest(options)) reasons.push('options not reversed');
    }
    return { valid: reasons.length === 0, reasons };
  }
  if (readPath(inputs.output, mutation.path) !== mutation.before || mutation.before === mutation.after) reasons.push('mutation did not happen');
  if (stableDigest(replaceLeaf(inputs.output, mutation.path, mutation.after)) !== stableDigest(trap.output)) reasons.push('output differs outside mutation');
  if (!textLeaves(inputs.output).some(leaf => normalizeWhitespace(leaf.text).includes(normalizeWhitespace(unit.text)))) reasons.push('base span absent');
  if (kind === 'injected-redundancy') {
    if (unit.paragraph === undefined || mutation.path.join('.') !== `body.${unit.paragraph + 1}` ||
      mutation.after !== `${mutation.before} ${mutation.source}` || normalizeWhitespace(mutation.source) !== normalizeWhitespace(unit.text)) reasons.push('redundancy not injected into next paragraph');
    const original = instantiateChecks(templates, baseDocument ?? trap.decomposition, inputs);
    for (const id of Object.keys(trap.intended_answers)) {
      const base = original.find(instance => instance.id === id);
      const changed = rendered.find(instance => instance.id === id);
      const occurrences = (projection: unknown) => textLeaves(projection).reduce((sum, leaf) =>
        sum + normalizeWhitespace(leaf.text).split(normalizeWhitespace(unit.text)).length - 1, 0);
      if (!base || !changed || stableDigest(base.projection) === stableDigest(changed.projection) ||
        occurrences(changed.projection) < 2 || occurrences(changed.projection) <= occurrences(base.projection)) reasons.push('redundancy invisible to affected check');
    }
  } else {
    if (!mutation.before.includes(mutation.source) || mutation.after !== mutation.before.replace(mutation.source, mutation.replacement)) reasons.push('span mutation mismatch');
    if (normalizeWhitespace(mutation.source) !== normalizeWhitespace(unit.text)) reasons.push('mutation does not target base unit');
  }
  if (kind === 'format-paraphrase' && mutation.replacement !== formatParaphrase(mutation.source)) reasons.push('not an allowed format paraphrase');
  return { valid: reasons.length === 0, reasons };
}
