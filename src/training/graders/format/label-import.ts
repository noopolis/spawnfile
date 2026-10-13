import { z } from 'zod';
import { identifier, parseSchema, parseYaml } from './common.js';
import { labelsSchema } from './labels.js';
import type { Grader } from './grader.js';

const reference = z.strictObject({ from: z.string().min(1) });
const importSchema = z.strictObject({
  schema: z.literal('paideia.label-import.v1'), grader: identifier,
  labelers: labelsSchema.shape.labelers,
  items: z.array(z.strictObject({
    id: identifier, lineage: identifier,
    example: z.strictObject({ dataset: identifier, id: identifier }).optional(),
    output: reference, context: z.record(identifier, reference).default({}),
    labeler: identifier, votes: z.record(identifier, z.union([z.string(), z.number().int()])),
    note: z.string().optional(),
  })),
});
export type LabelImport = z.infer<typeof importSchema>;

export function parseLabelImport(source: string, grader: Grader): LabelImport {
  const manifest = parseSchema(importSchema, parseYaml(source));
  if (manifest.grader !== grader.id) throw new Error('Import grader does not match grader.id');
  for (const [id, labeler] of Object.entries(manifest.labelers)) {
    if (grader.teachers.some(teacher => teacher.id === id)) throw new Error(`Import labeler ${id} collides with configured teacher`);
    if (labeler.kind !== 'human' && labeler.kind !== 'editor' && labeler.kind !== 'signal') throw new Error(`Import labeler ${id}: only human/editor/signal kinds are allowed`);
  }
  const seen = new Set<string>();
  for (const item of manifest.items) {
    if (!Object.hasOwn(manifest.labelers, item.labeler)) throw new Error(`Label ${item.id}: undeclared labeler ${item.labeler}`);
    for (const key of Object.keys(item.votes)) {
      const coordinate = JSON.stringify([item.id, item.labeler, key]);
      if (seen.has(coordinate)) throw new Error(`Label ${item.id}: duplicate import vote ${key}/${item.labeler}`);
      seen.add(coordinate);
    }
    for (const name of Object.keys(item.context)) {
      if (!Object.hasOwn(grader.context, name)) throw new Error(`Label ${item.id}: undeclared context ${name}`);
    }
  }
  return manifest;
}
