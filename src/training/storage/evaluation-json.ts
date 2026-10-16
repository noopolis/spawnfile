import type { ExperimentStore, ReadAccess, Visibility } from './types.js';
import { jsonBytes } from './content.js';

const marker = 'paideia.atomic-grading-blob.v1';
type WriteBlob = Pick<ExperimentStore, 'putBlob'>;
type ReadBlob = Pick<ExperimentStore, 'readBlob'>;

async function visit(value: unknown, atomic: (value: unknown) => Promise<unknown>, key = ''): Promise<unknown> {
  if (key === 'atomicGrading' && value !== undefined && value !== null) return atomic(value);
  if (Array.isArray(value)) return Promise.all(value.map(child => visit(child, atomic)));
  if (value && typeof value === 'object') {
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([name, child]) =>
      [name, await visit(child, atomic, name)])));
  }
  return value;
}

/** Wire format only. Scores and evidence are unchanged; identical grading bytes share one blob.
 * References retain their owning run's ACL, including sealed-test protection.
 */
export async function externalizeEvaluationJson(store: WriteBlob, runId: string, value: unknown,
  visibility: Visibility = 'evaluator'): Promise<unknown> {
  jsonBytes(value);
  const pending = new Map<string, Promise<unknown>>();
  return visit(value, detail => {
    const bytes = jsonBytes(detail);
    let reference = pending.get(bytes);
    if (!reference) {
      reference = store.putBlob(runId, bytes, visibility).then(blob => ({ schema: marker, blob }));
      pending.set(bytes, reference);
    }
    return reference;
  });
}

/** Hydrate only the reserved grading field, after the enclosing artifact's integrity/ACL check.
 * Legacy inline values are returned intact. readBlob verifies size, digest and stored permissions.
 */
export async function hydrateEvaluationJson<T>(store: ReadBlob, value: T, access: ReadAccess): Promise<T> {
  jsonBytes(value);
  return await visit(value, async detail => {
    if (typeof detail !== 'object' || detail === null || !('schema' in detail) || detail.schema !== marker) return detail;
    if (Object.keys(detail).sort().join(',') !== 'blob,schema' || !('blob' in detail)) throw new Error('Invalid grading blob reference');
    const reference = detail.blob as Parameters<ExperimentStore['readBlob']>[0];
    if (!reference || typeof reference !== 'object') throw new Error('Invalid grading blob reference');
    return JSON.parse((await store.readBlob(reference, access)).toString('utf8'));
  }) as T;
}
