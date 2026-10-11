import { stableDigest } from '../format/index.js';
import { evidenceRows, normalizeWhitespace, readPath, textLeaves } from '../decomposition/index.js';
import type { AtomicUnit, CheckTemplates, Decomposition, DecompositionInputs, TrapKind } from '../decomposition/index.js';
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
  if (/\bnot\s+/i.test(text)) return text.replace(/\bnot\s+/i, '');
  if (/\b(is|are|was|were|will|can|has|have|had|does|did)\b/i.test(text)) return text.replace(/\b(is|are|was|were|will|can|has|have|had|does|did)\b/i, '$& not');
  return undefined;
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
export function mutationFor(kind: TrapKind, unit: AtomicUnit, document: Decomposition, inputs: DecompositionInputs,
  templates: CheckTemplates, seed: string): TrapMutation | undefined {
  const located = locateSpan(inputs.output, unit.text);
  if (!located) return undefined;
  const rows = evidenceRows(templates, inputs);
  const cited = rows.filter(row => unit.cites?.includes(row.id)).map(row => row.text).join('\n');
  let replacement: string | undefined;
  let valueBefore: string | undefined;
  let valueAfter: string | undefined;
  if (kind === 'number-substitution' && cited) {
    valueBefore = /\b\d+(?:[,.]\d+)*\b/.exec(located.source)?.[0];
    let number = parseInt(stableDigest({ seed, unit: unit.id }).slice(0, 8), 16) % 900_000 + 100_000;
    while (cited.includes(String(number)) || located.source.includes(String(number))) number++;
    valueAfter = String(number);
  }
  if (kind === 'entity-substitution' && cited) {
    valueBefore = [unit.fields?.actor, unit.fields?.object].find(value => value && located.source.includes(value));
    const entities = [...document.units, ...(document.audit?.missed ?? [])].flatMap(other => [other.fields?.actor, other.fields?.object])
      .filter((value): value is string => Boolean(value && value !== valueBefore &&
        textLeaves(inputs.output).some(leaf => leaf.text.includes(value)) && !cited.toLowerCase().includes(value.toLowerCase())));
    valueAfter = entities.sort((a, b) => stableDigest({ seed, a }).localeCompare(stableDigest({ seed, a: b })))[0];
  }
  if (kind === 'citation-swap' && unit.cites?.length) {
    for (const declaration of Object.values(templates.context)) {
      if (!declaration.rows) continue;
      const match = [...located.source.matchAll(new RegExp(declaration.rows.cite, 'gm'))].find(item => unit.cites!.includes(item[1]!));
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
  if (kind === 'negation-flip') replacement = flipNegation(located.source);
  if (kind === 'format-paraphrase') replacement = formatParaphrase(located.source);
  if (kind === 'injected-redundancy' && unit.paragraph !== undefined) {
    const path = ['body', String(unit.paragraph + 1)];
    const before = readPath(inputs.output, path);
    if (typeof before !== 'string') return undefined;
    return { path, before, after: `${before} ${located.source}`, source: located.source, replacement: located.source };
  }
  if (valueBefore && valueAfter && !replacement) replacement = located.source.replace(valueBefore, valueAfter);
  if (!replacement || replacement === located.source) return undefined;
  return { ...located, after: located.before.replace(located.source, replacement), replacement,
    ...(valueBefore && valueAfter ? { value_before: valueBefore, value_after: valueAfter } : {}) };
}
