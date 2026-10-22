import type { DataMap, DataValue } from '../contracts/dataset.js';

export class DatasetError extends Error {
  constructor(public readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'DatasetError';
  }
}
export function fail(path: string, message: string): never {
  throw new DatasetError(path, message);
}
export function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail(path, 'expected a mapping');
  }
  return value as Record<string, unknown>;
}
export function fields(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, 'unknown field');
  }
}
export function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) return fail(path, 'expected a nonempty string');
  return value;
}
export function sequence(value: unknown, path: string, nonempty = true): unknown[] {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) {
    return fail(path, 'expected a nonempty sequence');
  }
  return value;
}
export function oneOf(value: unknown, choices: readonly unknown[], path: string): void {
  if (!choices.includes(value)) fail(path, `expected one of ${choices.join(', ')}`);
}
export function number(value: unknown, path: string, min = 0, max = 1): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    return fail(path, `expected a finite number between ${min} and ${max}`);
  }
  return value;
}
export function exclusive(value: Record<string, unknown>, keys: readonly string[], path: string,
  required = false): void {
  const present = keys.filter(key => value[key] !== undefined);
  if (present.length > 1 || (required && present.length !== 1)) {
    fail(path, `expected ${required ? 'exactly' : 'at most'} one of ${keys.join(', ')}`);
  }
}
export function safePath(value: unknown, path: string): string {
  const result = string(value, path);
  if (result.startsWith('/') || result.includes('\\') || result.includes('\0') ||
    result.split('/').some(part => part === '..' || part === '.' || !part) || /^[A-Za-z]:/.test(result)) {
    fail(path, 'expected a contained relative path');
  }
  return result;
}
export function json(value: unknown, path: string, depth = 0): DataValue {
  if (depth > 64) return fail(path, 'nesting exceeds 64 levels');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => json(item, `${path}[${index}]`, depth + 1));
  const map = object(value, path);
  const result: DataMap = {};
  for (const [key, item] of Object.entries(map)) {
    if (['__proto__', 'constructor', 'prototype', '<<'].includes(key)) fail(path, `unsupported key ${key}`);
    result[key] = json(item, `${path}.${key}`, depth + 1);
  }
  return result;
}
export function uniqueStrings(value: unknown, path: string, nonempty = true): string[] {
  const result = sequence(value, path, nonempty).map((item, index) => string(item, `${path}[${index}]`));
  if (new Set(result).size !== result.length) fail(path, 'duplicate identity');
  return result;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
