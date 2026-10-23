import { stableDigest, optionsFor, type Label, type Labels, type Grader, type LabelImport } from '../format/index.js';
import { groupLabelInstances, voteProvenance } from './planning.js';

/** Compare content identities, never reference spellings. Inline golden values use canonical JSON identity. */
function contentDigest(value: Label['output']): string {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'from' in value) return String(value.sha256);
  return stableDigest(value);
}

export function mergeImportedLabel(grader: Grader, labels: Labels, item: LabelImport['items'][number],
  incoming: Label, resolved: { output: Label['output']; context: Label['context'] },
  receipt: { import_digest: string; imported_at: string }, relabel = false): boolean {
  let target = labels.labels.find(label => label.id === item.id);
  const added = !target;
  if (target) {
    const content = (label: Label) => ({ output: contentDigest(label.output),
      context: Object.fromEntries(Object.entries(label.context).map(([name, value]) => [name, contentDigest(value)])) });
    if (stableDigest(content(target)) !== stableDigest(content(incoming))) throw new Error(`Label ${item.id}: output/context sha256 mismatch`);
    if (target.lineage !== item.lineage || item.example && stableDigest(target.example ?? null) !== stableDigest(item.example)) {
      throw new Error(`Label ${item.id}: lineage/example mismatch`);
    }
  } else { target = incoming; labels.labels.push(target); }
  const instances = new Map(groupLabelInstances(grader, resolved.output, resolved.context)
    .flatMap(group => group.instances.map(entry => [entry.instance.key, entry] as const)));
  for (const [key, vote] of Object.entries(item.votes)) {
    const entry = instances.get(key);
    if (!entry) throw new Error(`Label ${item.id}: instance ${key} is unknown, inapplicable or missing`);
    if (!optionsFor(entry.question).includes(vote)) throw new Error(`Label ${item.id}: invalid option for ${key}`);
    const questionDigest = entry.instance.definitionDigest;
    const prior = voteProvenance(target, item.labeler, key);
    const previous = target.votes[key]?.[item.labeler];
    const current = prior?.question_digest === questionDigest && prior.projection_digest === entry.instance.projectionDigest;
    if (previous !== undefined && (previous !== vote || !current) && !relabel) {
      throw new Error(`Label ${item.id}/${key}/${item.labeler}: changed or stale vote; use --relabel`);
    }
    // Preserve timestamps and byte-for-byte snapshots on replay, including after partial checkpoints.
    if (previous === vote && current && prior?.import_digest === receipt.import_digest && prior.note === (item.note ?? null)) continue;
    (target.votes[key] ??= {})[item.labeler] = vote;
    const provenance = target.provenance[item.labeler] ??= {};
    const votes = (provenance.votes ??= {}) as Record<string, Label['provenance'][string]>;
    votes[key] = { kind: labels.labelers[item.labeler]!.kind, note: item.note ?? null, ...receipt,
      question_digest: questionDigest, projection_digest: entry.instance.projectionDigest };
  }
  return added;
}
