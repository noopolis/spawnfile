import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { sha256, type Label } from '../../graders/index.js';

export interface DatasetExclusions {
  identities: { dataset: string; digest: string }[];
  ids: Set<string>;
  examples: Set<string>;
}

/** Dataset groups are label lineages; example identities retain their dataset namespace. */
export async function readExclusions(files: readonly string[]): Promise<DatasetExclusions> {
  const ids = new Set<string>();
  const examples = new Set<string>();
  const identities: DatasetExclusions['identities'] = [];
  for (const file of [...new Set(files.map(file => resolve(file)))].sort()) {
    const bytes = await readFile(file);
    const document = parseDocument(bytes.toString(), { uniqueKeys: true });
    if (document.errors.length || document.warnings.length) throw new Error(`Invalid exclusion dataset: ${file}`);
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (!value || typeof value !== 'object') throw new Error(`Invalid exclusion dataset: ${file}`);
    const data = value as Record<string, unknown>;
    if (!['paideia.dataset.v1', 'spawnfile.dataset.v1'].includes(String(data.schema))) throw new Error(`Unsupported exclusion dataset schema: ${file}`);
    const records = data.records ?? data.examples;
    if (!Array.isArray(records)) throw new Error(`Exclusion dataset requires records/examples: ${file}`);
    for (const record of records as unknown[]) {
      if (!record || typeof record !== 'object' || !('id' in record) || typeof record.id !== 'string' || !record.id.trim()) {
        throw new Error(`Exclusion dataset requires example IDs: ${file}`);
      }
      ids.add(record.id);
      if ('group' in record) {
        if (typeof record.group !== 'string' || !record.group.trim()) throw new Error(`Exclusion dataset requires nonempty groups: ${file}`);
        ids.add(record.group);
      }
      examples.add(JSON.stringify([file, record.id]));
      if (typeof data.id === 'string') examples.add(JSON.stringify([data.id, record.id]));
    }
    identities.push({ dataset: file, digest: sha256(bytes) });
  }
  return { identities, ids, examples };
}

export function excludeLabels(labels: readonly Label[], exclusions: DatasetExclusions): Label[] {
  const lineages = new Set(labels.filter(label => exclusions.ids.has(label.lineage) ||
    (label.example && exclusions.examples.has(JSON.stringify([label.example.dataset, label.example.id]))))
    .map(label => label.lineage));
  return labels.filter(label => !lineages.has(label.lineage));
}
