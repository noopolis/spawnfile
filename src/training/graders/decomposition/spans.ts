export function normalizeWhitespace(text: string): string { return text.replace(/\s+/gu, ' ').trim(); }
export function textLeaves(value: unknown, path: string[] = []): { path: string[]; text: string }[] {
  if (typeof value === 'string') return [{ path, text: value }];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, entry]) => textLeaves(entry, [...path, key]));
}
export function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
