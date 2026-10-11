import { stableDigest } from '../format/index.js';
import { evidenceRows, normalizeWhitespace, readPath, textLeaves } from '../decomposition/index.js';
import type { AtomicUnit, CheckTemplates, DecompositionInputs } from '../decomposition/index.js';
import type { Trap } from './types.js';
import { flipNegation, formatParaphrase, keyTerms, replaceLeaf } from './mutations.js';

/** Separate from candidate construction: validate the actual serialized variant. */
export function validateTrap(trap: Trap, unit: AtomicUnit, inputs: DecompositionInputs, templates: CheckTemplates): Trap['validation'] {
  const reasons: string[] = [];
  const { mutation: mutation, kind } = trap;
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
  } else {
    if (!mutation.before.includes(mutation.source) || mutation.after !== mutation.before.replace(mutation.source, mutation.replacement)) reasons.push('span mutation mismatch');
    if (normalizeWhitespace(mutation.source) !== normalizeWhitespace(unit.text)) reasons.push('mutation does not target base unit');
  }
  const rows = evidenceRows(templates, inputs);
  const cited = rows.filter(row => unit.cites?.includes(row.id)).map(row => row.text).join('\n');
  if (kind === 'number-substitution' || kind === 'entity-substitution') {
    const before = mutation.value_before; const after = mutation.value_after;
    if (!before || !after || !cited || cited.toLowerCase().includes(after.toLowerCase()) ||
      mutation.replacement !== mutation.source.replace(before, after) || before === after) reasons.push('substitution not absent from cited evidence');
    if (kind === 'number-substitution') {
      if (!/^\d+(?:[,.]\d+)*$/.test(before ?? '') || !/^\d+$/.test(after ?? '')) reasons.push('invalid numeric substitution');
      const numbers = cited.match(/\b\d+(?:[,.]\d+)*\b/g) ?? [];
      if (numbers.some(value => Number(value.replaceAll(',', '')) === Number(after))) reasons.push('numeric value already in cited evidence');
    }
    if (kind === 'entity-substitution' && !textLeaves(inputs.output).some(leaf => leaf.text.includes(after ?? '\u0000'))) reasons.push('replacement entity not in output');
  }
  if (kind === 'negation-flip' && mutation.replacement !== flipNegation(mutation.source)) reasons.push('negation not flipped');
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
