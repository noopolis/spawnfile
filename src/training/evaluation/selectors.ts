import { createHash } from 'node:crypto';
import type { EvaluationSnapshot, EvidenceReference } from '../contracts/evaluation.js';

export interface Selection { found: boolean; value?: unknown; evidence: EvidenceReference[] }

export function textReference(kind: 'input' | 'output' | 'sidecar', id: string, text: string): EvidenceReference {
  return { kind, id, digest: `sha256:${createHash('sha256').update(text).digest('hex')}` };
}

export function ownPath(value: unknown, parts: readonly string[]): unknown {
  let current = value;
  for (const part of parts) {
    if (part === '__proto__' || part === 'constructor' || part === 'prototype' ||
        typeof current !== 'object' || current === null || !Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function selectEvidence(selector: string, snapshot: EvaluationSnapshot): Selection {
  if (selector === 'output.text') {
    const output = snapshot.coverage.filter(row => row.channel === 'output');
    const found = output.length > 0 && output.every(row => row.completeness === 'complete');
    return { found, ...(found ? { value: snapshot.output } : {}), evidence: found
      ? [textReference('output', `${snapshot.trialId}/${snapshot.recordId}/output`, snapshot.output)] : [] };
  }
  if (selector === 'input:files') return { found: true, value: snapshot.inputFiles,
    evidence: Object.entries(snapshot.inputFiles).map(([id, value]) => textReference('input', id, value)) };
  const match = /^artifact:([^#]+)(?:#(.*))?$/.exec(selector);
  if (!match) throw new Error(`Unsupported evidence selector ${selector}`);
  const artifact = snapshot.artifacts[match[1]!];
  if (!artifact) return { found: false, evidence: [] };
  const pointer = match[2];
  if (pointer && (!pointer.startsWith('/') || /~[^01]/.test(pointer) || pointer.endsWith('~'))) {
    throw new Error('Invalid JSON pointer');
  }
  const value = pointer ? ownPath(artifact.value,
    pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))) : artifact.value;
  return { found: value !== undefined, value,
    evidence: [{ kind: 'artifact', id: artifact.checkpointId, digest: artifact.digest }] };
}

export function evidenceText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
