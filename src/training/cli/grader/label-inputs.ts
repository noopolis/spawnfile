import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { identifier, parseSchema, parseYaml } from '../../graders/format/index.js';
import { sha256, type Grader, type Label, type Labels } from '../../graders/index.js';

const reference = z.strictObject({ from: z.string().min(1) });
const manifestSchema = z.strictObject({ schema: z.literal('paideia.grader-inputs.v1'), items: z.array(z.strictObject({
  id: identifier, lineage: identifier, example: z.strictObject({ dataset: identifier, id: identifier }).optional(),
  output: reference, context: z.record(identifier, reference).default({}),
})) });
export interface LabelInput { label: Label; output: Label['output']; context: Label['context'] }

export async function loadLabelInputs(filename: string, grader: Grader, limit?: number): Promise<LabelInput[]> {
  if (typeof grader.golden !== 'string') throw new Error('grader label requires a separate golden labels file; inline golden labels are read-only');
  const labelsDirectory = path.dirname(grader.golden);
  const manifest = parseSchema(manifestSchema, parseYaml(await readFile(filename, 'utf8')));
  const ids = new Set<string>();
  for (const item of manifest.items) {
    if (ids.has(item.id)) throw new Error(`Duplicate input id ${item.id}`);
    ids.add(item.id);
    for (const name of Object.keys(item.context)) if (!Object.hasOwn(grader.context, name)) throw new Error(`Undeclared context ${name}`);
  }
  async function load(from: string) {
    const absolute = path.resolve(path.dirname(filename), from);
    const bytes = await readFile(absolute);
    const value = from.endsWith('.json') ? JSON.parse(bytes.toString('utf8')) as Label['output'] : bytes.toString('utf8');
    return { reference: { from: path.relative(labelsDirectory, absolute), sha256: sha256(bytes) }, value };
  }
  return Promise.all(manifest.items.slice(0, limit).map(async item => {
    const output = await load(item.output.from);
    const entries = await Promise.all(Object.entries(item.context).map(async ([name, ref]) => [name, await load(ref.from)] as const));
    return { output: output.value, context: Object.fromEntries(entries.map(([name, loaded]) => [name, loaded.value])),
      label: { id: item.id, lineage: item.lineage, ...(item.example ? { example: item.example } : {}), output: output.reference,
        context: Object.fromEntries(entries.map(([name, loaded]) => [name, loaded.reference])), votes: {}, provenance: {}, asked: [] } };
  }));
}

/** Verify all saved references, including outputs absent from the current manifest. */
export async function resolveStoredLabels(labels: Labels, filename: string): Promise<Labels> {
  async function resolve(value: Label['output']): Promise<Label['output']> {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !('from' in value)) return value;
    const ref = parseSchema(z.strictObject({ from: z.string().min(1), sha256: z.string() }), value);
    const bytes = await readFile(path.resolve(path.dirname(filename), ref.from));
    if (sha256(bytes) !== ref.sha256) throw new Error(`Stored label sha256 mismatch for ${ref.from}; use --relabel with that input`);
    return ref.from.endsWith('.json') ? JSON.parse(bytes.toString('utf8')) as Label['output'] : bytes.toString('utf8');
  }
  return { ...labels, labels: await Promise.all(labels.labels.map(async label => ({ ...label,
    output: await resolve(label.output),
    context: Object.fromEntries(await Promise.all(Object.entries(label.context).map(async ([name, value]) => [name, await resolve(value)]))),
  }))) };
}
