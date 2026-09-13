import type { FileSelector, ResolvedDataset, ResolvedRecord } from '../contracts/dataset.js';
import { fail } from './validation.js';

export function selectedFiles(record: ResolvedRecord): FileSelector[] {
  return [ ...(record.input?.files ?? []), ...(record.turns?.flatMap(turn => turn.input.files ?? []) ?? []),
    ...(record.reference?.files ?? []) ];
}
export function validateDatasetSplit(train: ResolvedDataset, test: ResolvedDataset, validation?: ResolvedDataset): void {
  const roles = [{ name: 'train', dataset: train }, ...(validation ? [{ name: 'validation', dataset: validation }] : []),
    { name: 'test', dataset: test }];
  const records = new Map<string, string>();
  const groups = new Map<string, string>();
  const files = new Map<string, string>();
  for (const { name, dataset } of roles) {
    if (dataset.subject !== train.subject) fail(name, 'native subject identity differs between roles');
    if (dataset.sharedPlanDigest !== train.sharedPlanDigest) fail(name, 'shared evaluation plan drift');
    for (const record of dataset.records) {
      if (!record.group) fail(`${name}.${record.id}`, 'evidence group is required');
      if (records.has(record.id)) fail(`${name}.${record.id}`, 'duplicate record membership across roles');
      records.set(record.id, name);
      const previousGroup = groups.get(record.group);
      if (previousGroup && previousGroup !== name) fail(name, `evidence-family leakage: ${record.group}`);
      groups.set(record.group, name);
      for (const file of selectedFiles(record)) {
        // Catch same source through changed hashes and identical bytes through renamed selectors.
        for (const identity of [`path:${file.resource}:${file.path}`, `bytes:${file.sha256}`]) {
          const previousRole = files.get(identity);
          if (previousRole && previousRole !== name) fail(name, `source evidence overlaps ${previousRole}: ${identity}`);
          files.set(identity, name);
        }
      }
    }
  }
}

export function validateReferenceIsolation(records: ResolvedRecord[]): void {
  const hidden = new Set<string>();
  for (const record of records) {
    for (const file of record.reference?.files ?? []) {
      hidden.add(`path:${file.resource}:${file.path}`);
      hidden.add(`bytes:${file.sha256}`);
    }
  }
  for (const record of records) {
    const visible = [...(record.input?.files ?? []), ...(record.turns?.flatMap(turn => turn.input.files ?? []) ?? [])];
    for (const file of visible) {
      if (hidden.has(`path:${file.resource}:${file.path}`) || hidden.has(`bytes:${file.sha256}`)) {
        fail(`record.${record.id}.input.files`, 'selected reference material cannot become subject input');
      }
    }
  }
}
