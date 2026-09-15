import type { ViewerData } from '../types.js';
import type { CandidateGroup, MetricSplit } from './types.js';

export interface CandidateIndex {
  groups: CandidateGroup[];
  splits: MetricSplit[];
  resolve(id: string): string;
  split(caseId: string): MetricSplit;
  expectedCases(split: MetricSplit): number | null;
}

/** Compatibility with the exact historical GEPA display identity; arbitrary IDs stay exact. */
function legacyNativeId(id: string): string {
  return /^GEPA \d+: (sha256:[a-f0-9]{64})$/.exec(id)?.[1] ?? id;
}

export function indexCandidates(data: ViewerData): CandidateIndex {
  const cases = new Map<string, MetricSplit>();
  for (const record of data.cases) {
    const previous = cases.get(record.id);
    cases.set(record.id, previous !== undefined && previous !== record.split ? 'unknown' : record.split);
  }
  const split = (caseId: string): MetricSplit => cases.get(caseId) ?? 'unknown';
  const aliases = new Map<string, string>();
  for (const candidate of data.candidates) {
    const nativeId = (candidate as typeof candidate & { nativeId?: string }).nativeId;
    aliases.set(candidate.id, nativeId ?? legacyNativeId(candidate.id));
  }
  const resolve = (id: string): string => aliases.get(id) ?? legacyNativeId(id);
  const groups = new Map<string, CandidateGroup>();
  const add = (sourceId: string) => {
    const id = resolve(sourceId);
    let group = groups.get(id);
    if (group === undefined) {
      group = { id, label: groups.size === 0 ? 'Baseline' : `Candidate ${groups.size}`,
        sourceIds: [], selected: false, splits: [] };
      groups.set(id, group);
    }
    if (!group.sourceIds.includes(sourceId)) group.sourceIds.push(sourceId);
    return group;
  };
  for (const candidate of data.candidates) {
    const group = add(candidate.id);
    if (candidate.label !== undefined) group.label = candidate.label;
  }
  for (const trial of data.trials) {
    const group = add(trial.candidateId);
    const trialSplit = split(trial.caseId);
    if (!group.splits.includes(trialSplit)) group.splits.push(trialSplit);
  }
  const selectedId = data.optimizer?.selectedCandidateId;
  if (selectedId !== undefined) {
    const selected = groups.get(resolve(selectedId));
    if (selected !== undefined) selected.selected = true;
  }
  const order: MetricSplit[] = ['train', 'validation', 'test', 'unknown'];
  for (const group of groups.values()) group.splits.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const presentSplits = new Set([...cases.values(), ...data.trials.map(trial => split(trial.caseId))]);
  return { groups: [...groups.values()], resolve, split,
    splits: order.filter(value => presentSplits.has(value)),
    expectedCases: value => value === 'unknown' ? null : [...cases.values()].filter(split => split === value).length };
}
