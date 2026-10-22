import { createHash } from 'node:crypto';
import type { CandidateManifest, CandidateResource } from './types.js';

export function digestBytes(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
export function canonicalCandidate(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalCandidate).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalCandidate(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function policyIdentity(resources: CandidateResource[]): string {
  return digestBytes(canonicalCandidate(resources.map(({ content: _content, digest: _digest, ...policy }) => policy)));
}
export function candidateIdentity(candidate: Omit<CandidateManifest, 'id' | 'baselineId'>,
  baselineId?: string): string {
  return digestBytes(canonicalCandidate({ ...candidate, ...(baselineId ? { baselineId } : {}) }));
}
export function freezeCandidate<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeCandidate(child);
    Object.freeze(value);
  }
  return value;
}
