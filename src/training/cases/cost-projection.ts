import type { CheckNode, FileSelector, ResolvedDataset, ResolvedRecord } from '../contracts/dataset.js';
import { selectedFiles } from './splits.js';

/** Contains no native inputs or executable evaluation record. */
export interface CostRecord {
  schema: 'paideia.cost-record.v1';
  id: string;
  group?: string;
  lineage?: string[];
  selectedFiles: FileSelector[];
  costChecks: Array<{ check: CheckNode; live: boolean }>;
}
export interface CostDataset {
  schema: 'paideia.cost-dataset.v1';
  id: string;
  subject?: string;
  sourceDigest: string;
  structureDigest: string;
  records: CostRecord[];
  preparation: { status: 'unverified'; profiles: string[]; checks: readonly ['availability', 'locks', 'parameter-semantics'] };
}

export function projectDatasetCost(dataset: ResolvedDataset): CostDataset {
  const profiles = new Set<string>();
  for (const record of dataset.records) if (typeof record.setup?.profile === 'string') profiles.add(record.setup.profile);
  return { schema: 'paideia.cost-dataset.v1', id: dataset.id, subject: dataset.subject,
    sourceDigest: dataset.sourceDigest, structureDigest: dataset.sharedPlanDigest,
    preparation: { status: 'unverified', profiles: [...profiles].sort(), checks: ['availability', 'locks', 'parameter-semantics'] },
    records: dataset.records.map(projectRecordCost) };
}

function projectRecordCost(record: ResolvedRecord): CostRecord {
  const costChecks: CostRecord['costChecks'] = [];
  const add = (check: CheckNode, live = false) => { costChecks.push({ check: structuredClone(check), live }); };
  for (const stage of record.effectiveStages) {
    if (stage.when) add(stage.when);
    stage.checks.forEach(check => add(check));
    if (stage.gate) add(stage.gate);
  }
  for (const turn of record.turns ?? []) for (const check of turn.checks ?? []) add(check);
  for (const check of record.live.checks) add(check, true);
  return { schema: 'paideia.cost-record.v1', id: record.id, group: record.group, ...(record.lineage ? { lineage: [...record.lineage] } : {}), selectedFiles: structuredClone(selectedFiles(record)), costChecks };
}
