import { createHash } from 'node:crypto';
import { isAlias, isMap, isScalar, isSeq, parseDocument, type Node } from 'yaml';
import { z } from 'zod';

export const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
export const identifier = z.string().min(1).refine(value =>
  !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value), 'control characters in identifier').refine(value =>
  !value.split(/[.@]/).some(part => unsafeKeys.has(part)), 'unsafe identifier');
export const probability = z.number().min(0).max(1);
export const provider = z.enum(['claude', 'grok'], { error: issue => issue.input === 'codex'
  ? 'codex exec has no native empty-tool attestation; use claude or grok' : 'expected claude or grok' });

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
    const issues = [...doc.errors, ...doc.warnings];
    const first = issues[0]!;
    const location = first.linePos?.[0];
    const detail = first.message.split('\n')[0]!.replace(/ at line \d+, column \d+:$/, '');
    throw new Error(`$: YAML ${location ? `line ${location.line}, column ${location.col}: ` : ''}${detail}` +
      (issues.length > 1 ? ` (${issues.length - 1} further errors)` : ''));
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

// Source location is IO metadata, excluded from serialized definitions and their digests.
const sourceDirectories = new WeakMap<object, string>();
export function rememberSourceDirectory(value: object, directory: string): void { sourceDirectories.set(value, directory); }
export function sourceDirectory(value: object): string { return sourceDirectories.get(value) ?? process.cwd(); }
