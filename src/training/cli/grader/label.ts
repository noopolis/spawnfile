import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { stringify, parseDocument } from 'yaml';
import type { InferenceProvider } from '../../contracts/execution.js';
import { loadGrader, parseLabelsYaml, parseLabels, labelsSchema, stableDigest, type Grader, type Labels } from '../../graders/index.js';
import { parseSchema } from '../../graders/format/index.js';
import { groupLabelInstances, validateStoredVotes, adjudicationRows } from '../../graders/labeling/index.js';
import { loadLabelInputs, resolveStoredLabels } from './label-inputs.js';
import { labelCall, createGraderTeacher } from './label-call.js';

export { createGraderTeacher } from './label-call.js';
export interface LabelOptions {
  graderFile: string; inputsFile: string; teachers: string[]; relabel?: boolean;
  adjudication?: number; concurrency?: number; limit?: number; signal?: AbortSignal;
}
export interface LabelDependencies { provider?: (teacher: Grader['teachers'][number]) => InferenceProvider }

export async function runLabel(options: LabelOptions, dependencies: LabelDependencies = {}): Promise<{
  labelsFile: string; adjudicationFile?: string; calls: number; votes: number; missing: number;
}> {
  const concurrency = options.concurrency ?? 2;
  for (const [name, value, minimum] of [['concurrency', concurrency, 1], ['limit', options.limit, 1], ['adjudication', options.adjudication, 0]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) throw new Error(`Invalid ${name}`);
  }
  const grader = await loadGrader(options.graderFile);
  if (!options.teachers.length || new Set(options.teachers).size !== options.teachers.length) throw new Error('Select unique teachers');
  const teachers = options.teachers.map(id => {
    const teacher = grader.teachers.find(t => t.id === id);
    if (!teacher) throw new Error(`Unknown teacher ${id}`);
    return teacher;
  });
  const inputs = await loadLabelInputs(options.inputsFile, grader, options.limit);
  let labels: Labels;
  try {
    const text = await readFile(grader.golden, 'utf8');
    if (options.relabel) {
      const document = parseDocument(text, { uniqueKeys: true, merge: false });
      if (document.errors.length || document.warnings.length) throw new Error('Invalid labels YAML');
      labels = parseSchema(labelsSchema, document.toJS({ maxAliasCount: 0 }));
      if (labels.grader !== grader.id) throw new Error('Labels grader mismatch');
    } else labels = parseLabelsYaml(text, grader);
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    labels = { schema: 'paideia.labels.v1', grader: grader.id, labelers: {}, labels: [] };
  }
  for (const teacher of teachers) {
    const previous = labels.labelers[teacher.id];
    if (previous?.kind === 'human') throw new Error(`Teacher ${teacher.id} collides with human labeler`);
    labels.labelers[teacher.id] = { kind: 'model', provider: teacher.provider, model: teacher.model };
  }
  const jobs: (() => Promise<void>)[] = [];
  const counts = { calls: 0, votes: 0, missing: 0 };
  const providers = new Map(teachers.map(t => [t.id, (dependencies.provider ?? createGraderTeacher)(t)]));
  for (const input of inputs) {
    let label = labels.labels.find(l => l.id === input.label.id);
    if (label) {
      const content = (value: typeof label) => [value!.output, value!.context, value!.lineage, value!.example];
      if (stableDigest(content(label)) !== stableDigest(content(input.label))) {
        if (!options.relabel) throw new Error(`Stale content ${label.id}; use --relabel`);
        Object.assign(label, input.label);
      }
    } else { label = input.label; labels.labels.push(label); }
    const target = label;
    if (options.relabel) for (const name of options.teachers) {
      for (const votes of Object.values(target.votes)) delete votes[name];
      delete target.provenance[name];
    }
    if (options.relabel) for (const [key, votes] of Object.entries(target.votes)) {
      if (!Object.keys(votes).length) delete target.votes[key];
    }
    target.asked = [...new Set([...target.asked ?? [], ...options.teachers])];
    for (const group of groupLabelInstances(grader, input.output, input.context)) {
      // Keep empty maps for unanswered instances so adjudication includes missing votes.
      for (const { instance } of group.instances) target.votes[instance.key] ??= {};
      for (const teacher of teachers) {
        if (group.instances.every(({ instance }) => Object.hasOwn(target.votes[instance.key]!, teacher.id))) continue;
        const pending = { ...group, instances: group.instances.filter(({ instance }) => !Object.hasOwn(target.votes[instance.key]!, teacher.id)) };
        jobs.push(async () => {
          const result = await labelCall(target, pending, teacher, providers.get(teacher.id)!, options.signal);
          counts.calls += result.calls; counts.votes += result.votes; counts.missing += result.missing;
        });
      }
    }
  }
  validateStoredVotes(grader, await resolveStoredLabels(labels, grader.golden), { resolved: true });
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) { options.signal?.throwIfAborted(); await jobs[next++]!(); }
  }));
  parseLabels(labels, grader);
  await mkdir(path.dirname(grader.golden), { recursive: true });
  const temporary = `${grader.golden}.${process.pid}.tmp`;
  await writeFile(temporary, stringify(labels), { mode: 0o600 });
  await rename(temporary, grader.golden);
  let adjudicationFile: string | undefined;
  if (options.adjudication !== undefined) {
    adjudicationFile = `${grader.golden}.adjudication.yaml`;
    await writeFile(adjudicationFile, stringify({ schema: 'paideia.grader-adjudication.v1', grader: grader.id,
      seed: 'paideia.adjudication.v1', items: adjudicationRows(labels, options.adjudication) }), { mode: 0o600 });
  }
  return { labelsFile: grader.golden, ...(adjudicationFile ? { adjudicationFile } : {}), ...counts };
}
