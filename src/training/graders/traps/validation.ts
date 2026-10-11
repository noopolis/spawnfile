import { stableDigest } from '../format/index.js';
import { evidenceRows, instantiateChecks, normalizeWhitespace, readPath, textLeaves, validateDecomposition } from '../decomposition/index.js';
import type { AtomicUnit, CheckTemplates, Decomposition, DecompositionInputs } from '../decomposition/index.js';
import type { Trap } from './types.js';
import { formatParaphrase, keyTerms, replaceLeaf } from './mutations.js';

import { affirmativeCounterpart, articleEntities, entityType, negator, numbers, numeric, plausibleNumber } from './preconditions.js';

/** Separate from candidate construction: validate the actual serialized variant. */
export function validateTrap(trap: Trap, unit: AtomicUnit, inputs: DecompositionInputs, templates: CheckTemplates, baseDocument?: Decomposition): Trap['validation'] {
  const reasons: string[] = [];
  const { mutation: mutation, kind } = trap;
  const variant = validateDecomposition(trap.decomposition, { ...inputs, output: trap.output }, templates);
  if (variant.rejected.length) reasons.push('invalid variant decomposition');
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
  const intended = Object.fromEntries(selected.map(instance => [instance.id, configured.find(template => template.id === instance.template_id)!.traps![kind]!]));
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
        changed.sentence !== base.sentence) reasons.push('variant changed unrelated unit state');
      const textChanged = normalizeWhitespace(expectedText) !== normalizeWhitespace(base.text);
      const expectedFields = Object.fromEntries(Object.entries(base.fields ?? {}).flatMap(([key, value]) => {
        if (value === undefined) return [];
        const expected = textChanged && mutation.value_before && mutation.value_after ? value.replace(mutation.value_before, mutation.value_after) : value;
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
  const rows = evidenceRows(templates, inputs);
  const cited = rows.filter(row => unit.cites?.includes(row.id)).map(row => row.text).join('\n');
  if (kind === 'number-substitution' || kind === 'entity-substitution') {
    const before = mutation.value_before; const after = mutation.value_after;
    if (!before || !after || !cited || cited.toLowerCase().includes(after.toLowerCase()) ||
      (kind === 'entity-substitution' && mutation.replacement !== mutation.source.replace(before, after)) || before === after) reasons.push('substitution not absent from cited evidence');
    if (kind === 'number-substitution') {
      if (!before || !after || !plausibleNumber(before, after)) reasons.push('invalid numeric substitution');
      const oldNumbers = numbers(mutation.source), newNumbers = numbers(mutation.replacement);
      const differences = oldNumbers.map((value, i) => ({ value, next: newNumbers[i] })).filter(item => item.value !== item.next);
      const oldShape = mutation.source.replace(/(?<![\p{L}\p{N}])\d+(?:[,.]\d+)*(?![\p{L}\p{N}])/gu, '#');
      const newShape = mutation.replacement.replace(/(?<![\p{L}\p{N}])\d+(?:[,.]\d+)*(?![\p{L}\p{N}])/gu, '#');
      if (oldShape !== newShape || oldNumbers.length !== newNumbers.length || differences.length !== 1 ||
        differences[0]?.value !== before || differences[0]?.next !== after) reasons.push('numeric substitution changed a different token');
      const values = numbers(cited).map(numeric);
      if (!before || !values.includes(numeric(before))) reasons.push('original number absent from cited evidence');
      if (after && values.includes(numeric(after))) reasons.push('numeric value already in cited evidence');
    }
    if (kind === 'entity-substitution') {
      if (!before || !cited.includes(before) || !entityType(before) || entityType(before) !== entityType(after ?? '') ||
        !articleEntities(inputs.output).includes(after ?? '')) reasons.push('unverified same-type entity substitution');
    }
  }
  if (kind === 'negation-flip') {
    const inserted = /\b(is|are|was|were|will|can|has|have|had|does|did) not\b/i.exec(mutation.replacement);
    if (!affirmativeCounterpart(mutation.source, cited, templates) || negator.test(mutation.source) || !inserted ||
      mutation.replacement.replace(/\bnot /i, '') !== mutation.source) reasons.push('negation lacks affirmative cited counterpart');
  }
  if (kind === 'format-paraphrase' && mutation.replacement !== formatParaphrase(mutation.source)) reasons.push('not an allowed format paraphrase');
  if (kind === 'citation-swap') {
    const target = rows.find(row => row.id === mutation.value_after);
    const patterns = Object.values(templates.context).flatMap(item => item.rows ? [item.rows.cite] : []);
    const old = patterns.flatMap(pattern => [...mutation.source.matchAll(new RegExp(pattern, 'gm'))]).find(match => match[1] === mutation.value_before);
    const terms = keyTerms(old ? mutation.source.replace(old[0], '') : mutation.source);
    if (!target || !old || !unit.cites?.includes(mutation.value_before!) || unit.cites.includes(target.id) || !terms.length ||
      terms.some(term => target.text.toLowerCase().includes(term)) ||
      mutation.replacement !== mutation.source.replace(old[0], old[0].replace(old[1]!, target.id))) reasons.push('citation replacement has overlapping key terms or invalid row');
  }
  return { valid: reasons.length === 0, reasons };
}
