
/** One train YAML can provide an explicitly frozen internal validation partition. */
export function partitionTraining<T extends { id: string; records: Array<{ group?: string }> }>(dataset: T, selectedGroups?: readonly string[]): {
  train: T; validation: T;
} {
  const groups = [...new Set(dataset.records.map(record => record.group))];
  if (groups.some(group => !group) || groups.length < 2) throw new Error('Training requires at least two nonempty evidence groups');
  const sorted = (groups as string[]).sort();
  const holdout = selectedGroups ?? sorted.slice(-Math.max(1, Math.floor(sorted.length * 0.2)));
  if (!holdout.length || new Set(holdout).size !== holdout.length || holdout.some(group => !sorted.includes(group))) {
    throw new Error('Validation groups must be unique existing training groups');
  }
  const train = dataset.records.filter(record => !holdout.includes(record.group!));
  const validation = dataset.records.filter(record => holdout.includes(record.group!));
  if (!train.length) throw new Error('Validation cannot consume every training group');
  return { train: { ...dataset, id: `${dataset.id}/train`, records: train },
    validation: { ...dataset, id: `${dataset.id}/validation`, records: validation } };
}
