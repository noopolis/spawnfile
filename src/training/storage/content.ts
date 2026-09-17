import { createHash } from 'node:crypto';
import { join } from 'node:path';

export function contentDigest(bytes: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
export function jsonBytes(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error('Stored JSON exceeds depth limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, child => jsonBytes(child, depth + 1)).join(',')}]`;
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Storage accepts plain JSON data only');
  return `{${Object.keys(value).sort().flatMap(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) throw new Error('Stored JSON cannot contain accessors');
    if (descriptor.value === undefined) return [];
    return [`${JSON.stringify(key)}:${jsonBytes(descriptor.value, depth + 1)}`];
  }).join(',')}}`;
}
export function identity(value: unknown): string { return contentDigest(jsonBytes(value)); }
export function assertIdentity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\0')) throw new Error('Invalid stored identity');
}
/**
 * Where `putBlob` stored this content, so an operator can be told a path that
 * outlives the run rather than a runtime-local one. Naming is all this does; a
 * read still goes through `readBlob` and its visibility gate.
 */
export function blobContentPath(storeRoot: string, reference: { digest: string }): string {
  return join(storeRoot, 'blobs', digestName(reference.digest));
}
export function digestName(digest: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid content digest');
  return digest.slice(7);
}
