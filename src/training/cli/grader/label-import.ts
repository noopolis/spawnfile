import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { loadGrader, parseLabelsYaml, parseLabels, sha256, stableDigest, type Label, type Labels } from '../../graders/index.js';
import { parseLabelImport } from '../../graders/format/index.js';
import { resolveStoredLabels } from './label-inputs.js';
import { mergeImportedLabel } from '../../graders/labeling/index.js';

export interface ImportLabelOptions { graderFile: string; importFile: string; relabel?: boolean; signal?: AbortSignal }
export interface ImportLabelSummary {
  labelsFile: string; items: number; labelsAdded: number; labelsMerged: number;
  votesByLabeler: Record<string, number>; votesByQuestion: Record<string, number>;
}

/** Validate and merge the entire transaction before replacing the checkpoint. No inference dependencies. */
export async function runLabelImport(options: ImportLabelOptions): Promise<ImportLabelSummary> {
  options.signal?.throwIfAborted();
  const grader = await loadGrader(options.graderFile);
  if (typeof grader.golden !== 'string') throw new Error('grader label requires a separate golden labels file; inline golden labels are read-only');
  const labelsFile = grader.golden;
  const bytes = await readFile(options.importFile, { signal: options.signal });
  const manifest = parseLabelImport(bytes.toString('utf8'), grader);
  let labels: Labels;
  let original: string | undefined;
  try {
    original = await readFile(labelsFile, 'utf8');
    labels = parseLabelsYaml(original, grader);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    labels = { schema: 'paideia.labels.v1', grader: grader.id, labelers: {}, labels: [] };
  }
  for (const [id, labeler] of Object.entries(manifest.labelers)) {
    const previous = labels.labelers[id];
    if (previous && stableDigest(previous) !== stableDigest(labeler)) throw new Error(`Conflicting labeler redefinition: ${id}`);
    labels.labelers[id] = labeler;
  }
  const receipt = { import_digest: sha256(bytes), imported_at: new Date().toISOString() };
  const added = new Set<string>(), merged = new Set<string>();
  const summary: ImportLabelSummary = { labelsFile, items: manifest.items.length, labelsAdded: 0, labelsMerged: 0,
    votesByLabeler: {}, votesByQuestion: {} };
  async function load(from: string) {
    const absolute = path.resolve(path.dirname(options.importFile), from);
    const bytes = await readFile(absolute, { signal: options.signal });
    const value = from.endsWith('.json') ? JSON.parse(bytes.toString('utf8')) as Label['output'] : bytes.toString('utf8');
    return { reference: { from: path.relative(path.dirname(labelsFile), absolute), sha256: sha256(bytes) }, value };
  }
  for (const item of manifest.items) {
    options.signal?.throwIfAborted();
    const output = await load(item.output.from);
    const context = await Promise.all(Object.entries(item.context).map(async ([name, ref]) => [name, await load(ref.from)] as const));
    const incoming: Label = { id: item.id, lineage: item.lineage, ...(item.example ? { example: item.example } : {}),
      output: output.reference, context: Object.fromEntries(context.map(([name, value]) => [name, value.reference])), votes: {}, provenance: {} };
    const isNew = mergeImportedLabel(grader, labels, item, incoming,
      { output: output.value, context: Object.fromEntries(context.map(([name, value]) => [name, value.value])) }, receipt, options.relabel);
    if (isNew) added.add(item.id);
    else if (!added.has(item.id)) merged.add(item.id);
    for (const key of Object.keys(item.votes)) {
      summary.votesByLabeler[item.labeler] = (summary.votesByLabeler[item.labeler] ?? 0) + 1;
      const question = key.split('@')[0]!;
      summary.votesByQuestion[question] = (summary.votesByQuestion[question] ?? 0) + 1;
    }
  }
  parseLabels(labels, grader);
  // Verify saved references too, including historical labels absent from this import.
  await resolveStoredLabels(labels, labelsFile);
  summary.labelsAdded = added.size; summary.labelsMerged = merged.size;
  const snapshot = stringify(labels);
  if (snapshot === original) return summary;
  await mkdir(path.dirname(labelsFile), { recursive: true });
  const temporary = `${labelsFile}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, snapshot, { mode: 0o600, flag: 'wx', signal: options.signal });
    options.signal?.throwIfAborted();
    await rename(temporary, labelsFile);
  } finally { await rm(temporary, { force: true }); }
  return summary;
}
