import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import type { InferenceProvider, InferenceFailureKind } from '../../contracts/execution.js';
import { askedForInstance, loadGrader, parseLabelsYaml, parseLabels, labelsSchema, stableDigest, type Grader, type Labels } from '../../graders/index.js';
import { parseSchema, parseYaml } from '../../graders/format/index.js';
import { groupLabelInstances, validateStoredVotes, adjudicationRows, voteProvenance, teacherPolicyDigest } from '../../graders/labeling/index.js';
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
  failures: Record<string, Partial<Record<InferenceFailureKind, number>>>; stopped: Record<string, InferenceFailureKind>;
}> {
  const concurrency = options.concurrency ?? 2;
  for (const [name, value, minimum] of [['concurrency', concurrency, 1], ['limit', options.limit, 1], ['adjudication', options.adjudication, 0]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) throw new Error(`Invalid ${name}`);
  }
  const grader = await loadGrader(options.graderFile);
  if (typeof grader.golden !== 'string') throw new Error('grader label requires a separate golden labels file; inline golden labels are read-only');
  const labelsFile = grader.golden;
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
      labels = parseSchema(labelsSchema, parseYaml(text));
      if (labels.grader !== grader.id) throw new Error('Labels grader mismatch');
    } else labels = parseLabelsYaml(text, grader);
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    labels = { schema: 'paideia.labels.v1', grader: grader.id, labelers: {}, labels: [] };
  }
  for (const teacher of teachers) {
    const previous = labels.labelers[teacher.id];
    if (previous && previous.kind !== 'model') throw new Error(`Teacher ${teacher.id} collides with ${previous.kind} labeler`);
    labels.labelers[teacher.id] = { kind: 'model', provider: teacher.provider, model: teacher.model };
  }
  const jobs: (() => Promise<void>)[] = [];
  let checkpoint = Promise.resolve();
  const persist = () => {
    parseLabels(labels, grader);
    const snapshot = stringify(labels);
    checkpoint = checkpoint.then(async () => {
      await mkdir(path.dirname(labelsFile), { recursive: true });
      const temporary = `${labelsFile}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, labelsFile);
    });
    return checkpoint;
  };
  const counts = { calls: 0, votes: 0, missing: 0 };
  const failures = Object.fromEntries(teachers.map(teacher => [teacher.id, {} as Partial<Record<InferenceFailureKind, number>>]));
  const stopped: Record<string, InferenceFailureKind> = {};
  const providers = new Map(teachers.map(t => [t.id, (dependencies.provider ?? createGraderTeacher)(t)]));
  for (const input of inputs) {
    let label = labels.labels.find(l => l.id === input.label.id);
    if (label) {
      const content = (value: typeof label) => [value!.output, value!.context, value!.lineage, value!.example];
      if (stableDigest(content(label)) !== stableDigest(content(input.label))) {
        if (!options.relabel) throw new Error(`Stale content ${label.id}; use --relabel`);
        Object.assign(label, input.label, { askedByInstance: {} });
      }
    } else { label = input.label; labels.labels.push(label); }
    const target = label;
    if (options.relabel) for (const name of options.teachers) {
      for (const votes of Object.values(target.votes)) delete votes[name];
      delete target.provenance[name];
      if (target.asked) target.asked = target.asked.filter(id => id !== name);
      for (const [key, asked] of Object.entries(target.askedByInstance ?? {})) target.askedByInstance![key] = asked.filter(id => id !== name);
    }
    if (options.relabel) for (const [key, votes] of Object.entries(target.votes)) {
      if (!Object.keys(votes).length) {
        delete target.votes[key];
        if (target.askedByInstance?.[key]?.length === 0) delete target.askedByInstance[key];
      }
    }
    // Snapshot legacy denominators before dispatch can change the output-wide summary.
    const groups = groupLabelInstances(grader, input.output, input.context);
    const membership = Object.fromEntries(groups.flatMap(group => group.instances.map(({ instance }) =>
      [instance.key, askedForInstance(target, instance.key)])));
    target.askedByInstance = { ...target.askedByInstance, ...membership };
    const outputJobs: (() => Promise<void>)[] = [];
    for (const group of groups) {
      // Keep empty maps for unanswered instances so adjudication includes missing votes.
      for (const { instance } of group.instances) target.votes[instance.key] ??= {};
      for (const teacher of teachers) {
        const pending = { ...group, instances: group.instances.filter(({ instance, question }) => {
          const receipt = voteProvenance(target, teacher.id, instance.key);
          if (receipt?.status === 'refused' && receipt.teacher_policy_digest === teacherPolicyDigest(teacher) &&
            receipt.question_digest === stableDigest(question) && receipt.projection_digest === group.projectionDigest) {
            counts.missing++;
            return false;
          }
          return !Object.hasOwn(target.votes[instance.key]!, teacher.id);
        }) };
        if (!pending.instances.length) continue;
        outputJobs.push(async () => {
          if (Object.hasOwn(stopped, teacher.id)) return;
          for (const { instance } of pending.instances) {
            target.askedByInstance![instance.key] = [...new Set([...target.askedByInstance![instance.key]!, teacher.id])];
          }
          target.asked = [...new Set([...target.asked ?? [], teacher.id])];
          const result = await labelCall(target, pending, teacher, providers.get(teacher.id)!, options.signal);
          if (result.stopped) stopped[teacher.id] = result.stopped;
          const teacherFailures = failures[teacher.id] ??= {};
          for (const [kind, count] of Object.entries(result.failures)) {
            const failureKind = kind as InferenceFailureKind;
            teacherFailures[failureKind] = (teacherFailures[failureKind] ?? 0) + count;
          }
          counts.calls += result.calls; counts.votes += result.votes; counts.missing += result.missing;
        });
      }
    }
    jobs.push(async () => {
      for (const job of outputJobs) { options.signal?.throwIfAborted(); await job(); }
      await persist();
    });
  }
  validateStoredVotes(grader, await resolveStoredLabels(labels, grader.golden), { resolved: true });
  let next = 0;
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) { options.signal?.throwIfAborted(); await jobs[next++]!(); }
  }));
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  await persist();
  let adjudicationFile: string | undefined;
  if (options.adjudication !== undefined) {
    adjudicationFile = `${grader.golden}.adjudication.yaml`;
    await writeFile(adjudicationFile, stringify({ schema: 'paideia.grader-adjudication.v1', grader: grader.id,
      seed: 'paideia.adjudication.v1', items: adjudicationRows(labels, options.adjudication) }), { mode: 0o600 });
  }
  return { labelsFile: grader.golden, ...(adjudicationFile ? { adjudicationFile } : {}), ...counts, failures, stopped };
}
