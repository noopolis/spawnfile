import { createHash } from 'node:crypto';
import { isAlias, isMap, isScalar, isSeq, parseDocument, type Node } from 'yaml';
import { z } from 'zod';

export const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
export const identifier = z.string().min(1).refine(value =>
  !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value), 'control characters in identifier').refine(value =>
  !value.split(/[.@]/).some(part => unsafeKeys.has(part)), 'unsafe identifier');
export const probability = z.number().min(0).max(1);
export const provider = z.enum(['codex', 'claude', 'grok']);

export function rejectUnsafeKeys(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (unsafeKeys.has(key)) throw new Error(`${path}.${key}: unsafe map key`);
    rejectUnsafeKeys((value as Record<string, unknown>)[key], `${path}.${key}`);
  }
}

export function parseSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  rejectUnsafeKeys(value);
  const result = schema.safeParse(value);
  function messages(issues: z.core.$ZodIssue[], parent: PropertyKey[] = []): string[] {
    return issues.flatMap(issue => {
      const location = [...parent, ...issue.path];
      if (issue.code === 'invalid_union') return issue.errors.flatMap(branch => messages(branch, location));
      return [`$.${location.join('.')}: ${issue.message}`];
    });
  }
  if (!result.success) throw new Error(messages(result.error.issues).join('\n'));
  return result.data;
}

export function parseYaml(source: string): unknown {
  const doc = parseDocument(source, { uniqueKeys: true, version: '1.2', merge: false });
  if (doc.errors.length || doc.warnings.length) {
    throw new Error(`$: ${[...doc.errors, ...doc.warnings].map(e => e.message).join('\n')}`);
  }
  function visit(node: Node | null | undefined): void {
    if (isAlias(node)) throw new Error('$: YAML aliases are unsupported');
    if (isMap(node)) for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new Error('$: map keys must be strings');
      visit(pair.value as Node);
    }
    if (isSeq(node)) node.items.forEach(item => visit(item as Node));
  }
  visit(doc.contents);
  return doc.toJS({ maxAliasCount: 0 });
}

export function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** JSON identity ignores object insertion order, but preserves array order. */
export function stableDigest(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === 'object') return Object.fromEntries(
      Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, entry]) => [key, canonical(entry)]));
    return item;
  }
  return sha256(JSON.stringify(canonical(value)));
}
