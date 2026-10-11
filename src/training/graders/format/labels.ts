import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { identifier, provider, parseSchema, parseYaml, sha256, stableDigest, rejectUnsafeKeys, sourceDirectory } from './common.js';
import type { Grader } from './grader.js';
import { optionsFor, allQuestions } from './questions.js';

const referenceSchema = z.strictObject({ from: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const labelerSchema = z.union([
  z.strictObject({ kind: z.literal('model'), provider, model: z.string().min(1) }),
  z.strictObject({ kind: z.literal('human'), name: z.string().min(1) }),
]);
export const labelsSchema = z.strictObject({
  schema: z.literal('paideia.labels.v1'), grader: identifier,
  labelers: z.record(identifier, labelerSchema),
  labels: z.array(z.strictObject({
    id: identifier, lineage: identifier,
    example: z.strictObject({ dataset: identifier, id: identifier }).optional(),
    output: z.json(), context: z.record(identifier, z.json()),
    asked: z.array(identifier).optional(),
    askedByInstance: z.record(identifier, z.array(identifier)).optional(),
    votes: z.record(identifier, z.record(identifier, z.union([z.string(), z.number().int()]))),
    provenance: z.record(identifier, z.record(z.string(), z.json())),
  })),
});
export type Labels = z.infer<typeof labelsSchema>;
export type Label = Labels['labels'][number];
export type Labeler = Labels['labelers'][string];

function validateReference(value: unknown, location: string): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'from' in value) {
    try { parseSchema(referenceSchema, value); }
    catch (error) { throw new Error(`${location}: ${String(error)}`, { cause: error }); }
  }
}

export function parseLabels(value: unknown, grader: Grader): Labels {
  const labels = parseSchema(labelsSchema, value);
  if (labels.grader !== grader.id) throw new Error('$.grader: does not match grader.id');
  const questions = new Map(allQuestions(grader).map(question => [question.id, question]));
  const ids = new Set<string>();
  labels.labels.forEach((label, i) => {
    const location = `$.labels.${i}`;
    if (ids.has(label.id)) throw new Error(`${location}.id: duplicate label`);
    ids.add(label.id);
    validateReference(label.output, `${location}.output`);
    for (const [name, value] of Object.entries(label.context)) {
      if (!Object.hasOwn(grader.context, name)) throw new Error(`${location}.context.${name}: undeclared context`);
      validateReference(value, `${location}.context.${name}`);
    }
    for (const name of [...label.asked ?? [], ...Object.values(label.askedByInstance ?? {}).flat(), ...Object.keys(label.provenance)]) {
      if (!Object.hasOwn(labels.labelers, name)) throw new Error(`${location}.asked/provenance.${name}: unknown labeler`);
    }
    for (const [key, votes] of Object.entries({ ...Object.fromEntries(Object.keys(label.askedByInstance ?? {}).map(key => [key, {}])), ...label.votes })) {
      const match = /^(.*?)(?:@p(0|[1-9]\d*)(?:\.s(0|[1-9]\d*))?)?$/s.exec(key)!;
      const question = questions.get(match[1]!);
      if (!question) throw new Error(`${location}.votes.${key}: unknown question`);
      const hasParagraph = match[2] !== undefined;
      const hasSentence = match[3] !== undefined;
      if (question.level === 'article' ? hasParagraph : question.level === 'paragraph' ? !hasParagraph || hasSentence : !hasSentence) {
        throw new Error(`${location}.votes.${key}: instance suffix does not match level`);
      }
      const options = optionsFor(question);
      for (const [labeler, vote] of Object.entries(votes)) {
        if (!Object.hasOwn(labels.labelers, labeler)) throw new Error(`${location}.votes.${key}.${labeler}: unknown labeler`);
        if (vote !== 'abstain' && !options.includes(vote)) throw new Error(`${location}.votes.${key}.${labeler}: invalid option`);
      }
    }
  });
  return labels;
}
export function parseLabelsYaml(source: string, grader: Grader): Labels { return parseLabels(parseYaml(source), grader); }

/** JSON references decode JSON; other references retain exact UTF-8 text. */
async function resolveValue(value: Label['output'], directory: string, label: string): Promise<Label['output']> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !('from' in value)) return value;
  const reference = parseSchema(referenceSchema, value);
  const bytes = await readFile(path.resolve(directory, reference.from));
  if (sha256(bytes) !== reference.sha256) throw new Error(`label ${label}: sha256 mismatch for ${reference.from}`);
  const resolved: Label['output'] = reference.from.endsWith('.json') ? JSON.parse(bytes.toString('utf8')) as Label['output'] : bytes.toString('utf8');
  rejectUnsafeKeys(resolved, `label ${label}`);
  return resolved;
}

export async function loadLabels(source: Grader['golden'], grader: Grader): Promise<{ labels: Labels; goldenDigest: string }> {
  const labels = typeof source === 'string' ? parseLabelsYaml(await readFile(source, 'utf8'), grader)
    : parseLabels({ ...source, grader: source.grader ?? grader.id }, grader);
  const directory = typeof source === 'string' ? path.dirname(source) : sourceDirectory(grader);
  // Identity includes original content addresses, votes, asked set and provenance.
  const goldenDigest = stableDigest(labels);
  const resolved = await Promise.all(labels.labels.map(async label => ({
    ...label,
    output: await resolveValue(label.output, directory, label.id),
    context: Object.fromEntries(await Promise.all(Object.entries(label.context).map(async ([name, value]) =>
      [name, await resolveValue(value, directory, label.id)]))),
  })));
  return { labels: { ...labels, labels: resolved }, goldenDigest };
}
