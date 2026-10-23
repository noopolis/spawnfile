import { isDeepStrictEqual } from 'node:util';
import type { ResolvedRecord } from '../../contracts/dataset.js';
import type { ExperimentStore, ReadAccess } from '../../storage/index.js';

/** Resolve the original protected record from its captured, integrity-checked blob. */
export async function verifyCapturedRecord(store: ExperimentStore, runId: string, access: ReadAccess,
  expected: ResolvedRecord): Promise<ResolvedRecord> {
  const references = await store.listBlobs(runId, access);
  const records: ResolvedRecord[] = [];
  for (const reference of references) {
    const bytes = await store.readBlob(reference, access);
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { continue; }
    if (value && typeof value === 'object' && 'id' in value && value.id === expected.id &&
        'effectiveStages' in value && Array.isArray(value.effectiveStages)) records.push(value as ResolvedRecord);
  }
  if (records.length !== 1 || !isDeepStrictEqual(records[0], JSON.parse(JSON.stringify(expected)))) {
    throw new Error('Repair criteria differ from the original captured record');
  }
  return records[0]!;
}
