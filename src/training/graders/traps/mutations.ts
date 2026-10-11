import { stableDigest } from '../format/index.js';
import { evidenceRows, normalizeWhitespace, readPath, textLeaves } from '../decomposition/index.js';
import type { AtomicUnit, CheckTemplates, Decomposition, DecompositionInputs, TrapKind } from '../decomposition/index.js';
import { affirmativeCounterpart, articleEntities, entityType, coReferent, maskCitations, withoutHeadings, negationAuxiliary, numbers, numeric, plausibleNumber } from './preconditions.js';
import type { TrapMutation } from './types.js';

export function replaceLeaf(output: unknown, path: string[], after: string): unknown {
  if (!path.length) return after;
  const copy: unknown = structuredClone(output);
  const parent = readPath(copy, path.slice(0, -1)) as Record<string, unknown>;
  parent[path.at(-1)!] = after;
  return copy;
}
function escaped(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
export function locateSpan(output: unknown, text: string): { path: string[]; before: string; source: string } | undefined {
  const expression = normalizeWhitespace(text).split(' ').map(escaped).join('\\s+');
  const matches = textLeaves(output).flatMap(leaf => [...leaf.text.matchAll(new RegExp(expression, 'gu'))]
    .map(match => ({ path: leaf.path, before: leaf.text, source: match[0] })));
  return matches.length === 1 ? matches[0] : undefined;
}
export function flipNegation(text: string): string | undefined {
  const match = negationAuxiliary(text);
  return match ? text.slice(0, match.index) + match[0] + ' not' + text.slice(match.index! + match[0].length) : undefined;
}
export function formatParaphrase(text: string): string | undefined {
  if (/\b\d{1,3}(?:,\d{3})+\b/.test(text)) return text.replace(/\b\d{1,3}(?:,\d{3})+\b/, value => value.replaceAll(',', ''));
  if (/\bper cent\b/i.test(text)) return text.replace(/\bper cent\b/i, 'percent');
  if (/\bpercent\b/i.test(text)) return text.replace(/\bpercent\b/i, 'per cent');
  if (/\bsaid\b/i.test(text)) return text.replace(/\bsaid\b/i, 'stated');
  if (/\bstated\b/i.test(text)) return text.replace(/\bstated\b/i, 'said');
  return undefined;
}
export function keyTerms(text: string): string[] {
  const stop = new Set(['that', 'this', 'with', 'from', 'have', 'were', 'been', 'said', 'will', 'they', 'their', 'there', 'than', 'into']);
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(word => word.length > 3 && !stop.has(word));
}
export function mutationFor(kind: TrapKind, unit: AtomicUnit, _document: Decomposition, inputs: DecompositionInputs,
  templates: CheckTemplates, seed: string): TrapMutation | undefined {
  const located = locateSpan(inputs.output, unit.text);
  if (!located) return undefined;
  const rows = evidenceRows(templates, inputs);
  const cited = rows.filter(row => unit.cites?.includes(row.id)).map(row => withoutHeadings(row.text, templates)).join('\n');
  const claim = maskCitations(located.source, templates);
  let replacement: string | undefined;
  let valueBefore: string | undefined;
  let valueAfter: string | undefined;
  if (kind === 'number-substitution' && cited) {
    valueBefore = numbers(claim).find(value => numbers(cited).some(item => numeric(item) === numeric(value)));
    if (valueBefore) {
      const precision = numeric(valueBefore).split('.')[1]?.length ?? 0;
      const step = 10 ** -precision;
      const sign = parseInt(stableDigest({ seed, unit: unit.id }).slice(0, 2), 16) % 2 ? 1 : -1;
      for (const delta of [sign, -sign, 2 * sign, -2 * sign]) {
        const candidate = (Number(numeric(valueBefore)) + delta * step).toFixed(precision);
        if (plausibleNumber(valueBefore, candidate) && !numbers(cited).some(value => numeric(value) === candidate)) {
          valueAfter = candidate; break;
        }
      }
    }
  }
  if (kind === 'entity-substitution' && cited) {
    const entities = articleEntities(inputs.output);
    valueBefore = entities.find(value => located.source.includes(value) && cited.includes(value));
    valueAfter = entities.filter(value => !coReferent(valueBefore ?? '', value) && entityType(value) === entityType(valueBefore ?? '') &&
      !cited.toLowerCase().includes(value.toLowerCase()))
      .sort((a, b) => stableDigest({ seed, a }).localeCompare(stableDigest({ seed, a: b })))[0];
  }
  if (kind === 'citation-swap' && unit.cites?.length === 1) {
    for (const declaration of Object.values(templates.context)) {
      if (!declaration.rows) continue;
      const matches = [...located.source.matchAll(new RegExp(declaration.rows.cite, 'gm'))];
      const match = matches.length === 1 ? matches.find(item => unit.cites!.includes(item[1]!)) : undefined;
      if (!match) continue;
      const terms = keyTerms(located.source.replace(match[0], ''));
      const next = rows.find(row => !unit.cites!.includes(row.id) && terms.length > 0 &&
        !terms.some(term => row.text.toLowerCase().includes(term)));
      if (!next) continue;
      valueBefore = match[1]; valueAfter = next.id;
      replacement = located.source.replace(match[0], match[0].replace(valueBefore!, valueAfter));
      break;
    }
  }
  if (kind === 'negation-flip' && affirmativeCounterpart(located.source, cited, templates)) replacement = flipNegation(located.source);
  if (kind === 'format-paraphrase') replacement = formatParaphrase(located.source);
  if (kind === 'injected-redundancy' && unit.paragraph !== undefined) {
    const path = ['body', String(unit.paragraph + 1)];
    const before = readPath(inputs.output, path);
    if (typeof before !== 'string') return undefined;
    return { path, before, after: `${before} ${located.source}`, source: located.source, replacement: located.source };
  }
  if (valueBefore && valueAfter && !replacement) {
    let changed = false;
    replacement = kind === 'number-substitution' ? located.source.replace(/(?<![\p{L}\p{N}])\d+(?:[,.]\d+)*(?![\p{L}\p{N}])/gu, (value, offset: number) => {
      if (changed || value !== valueBefore || claim.slice(offset, offset + value.length) !== value) return value;
      changed = true;
      return valueAfter!;
    }) : located.source.replace(valueBefore, valueAfter);
  }
  if (!replacement || replacement === located.source) return undefined;
  return { ...located, after: located.before.replace(located.source, replacement), replacement,
    ...(valueBefore && valueAfter ? { value_before: valueBefore, value_after: valueAfter } : {}) };
}
