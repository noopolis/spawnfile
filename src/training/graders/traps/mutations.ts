import { normalizeWhitespace, readPath, textLeaves } from '../decomposition/index.js';
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
export function formatParaphrase(text: string): string | undefined {
  if (/\b\d{1,3}(?:,\d{3})+\b/.test(text)) return text.replace(/\b\d{1,3}(?:,\d{3})+\b/, value => value.replaceAll(',', ''));
  if (/\bper cent\b/i.test(text)) return text.replace(/\bper cent\b/i, 'percent');
  if (/\bpercent\b/i.test(text)) return text.replace(/\bpercent\b/i, 'per cent');
  if (/\bsaid\b/i.test(text)) return text.replace(/\bsaid\b/i, 'stated');
  if (/\bstated\b/i.test(text)) return text.replace(/\bstated\b/i, 'said');
  return undefined;
}
export function mutationFor(kind: TrapKind, unit: AtomicUnit, _document: Decomposition, inputs: DecompositionInputs,
  _templates: CheckTemplates, _seed: string): TrapMutation | undefined {
  const located = locateSpan(inputs.output, unit.text);
  if (!located) return undefined;
  let replacement: string | undefined;
  if (kind === 'format-paraphrase') replacement = formatParaphrase(located.source);
  if (kind === 'injected-redundancy' && unit.paragraph !== undefined) {
    const path = ['body', String(unit.paragraph + 1)];
    const before = readPath(inputs.output, path);
    if (typeof before !== 'string') return undefined;
    return { path, before, after: `${before} ${located.source}`, source: located.source, replacement: located.source };
  }
  if (!replacement || replacement === located.source) return undefined;
  return { ...located, after: located.before.replace(located.source, replacement), replacement };
}
