import { readFile, mkdir, rename, writeFile, readdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { identifier, parseSchema, parseYaml } from '../../../graders/format/index.js';
import { sha256, stableDigest } from '../../../graders/index.js';
import { parseCheckTemplatesYaml, parseDecomposition, validateDecomposition } from '../../../graders/decomposition/index.js';
import type { CheckTemplates, Decomposition } from '../../../graders/decomposition/index.js';

const reference = z.strictObject({ from: z.string().min(1) });
const manifestSchema = z.strictObject({ schema: z.literal('paideia.grader-inputs.v1'), items: z.array(z.strictObject({
  id: identifier, lineage: identifier, example: z.strictObject({ dataset: identifier, id: identifier }).optional(),
  output: reference, context: z.record(identifier, reference).default({}),
})) });
export interface AtomicInput {
  id: string; output: unknown; context: Record<string, unknown>;
  refs: Pick<Decomposition, 'output' | 'context'>;
}
export async function readTemplates(file: string): Promise<CheckTemplates> {
  return parseCheckTemplatesYaml(await readFile(file, 'utf8'));
}
export async function readOptional<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
export async function atomicWrite(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}
async function readValue(from: string, expected?: string) {
  const bytes = await readFile(from);
  const digest = sha256(bytes);
  if (expected !== undefined && digest !== expected) throw new Error(`Content digest mismatch: ${from}`);
  return { value: from.endsWith('.json') ? JSON.parse(bytes.toString('utf8')) as unknown : bytes.toString('utf8'),
    reference: { from, sha256: digest } };
}
export async function readInputs(file: string, templates: CheckTemplates): Promise<AtomicInput[]> {
  const manifest = parseSchema(manifestSchema, parseYaml(await readFile(file, 'utf8')));
  if (new Set(manifest.items.map(item => item.id)).size !== manifest.items.length) throw new Error('Duplicate input id');
  return Promise.all(manifest.items.map(async item => {
    for (const name of Object.keys(item.context)) if (!Object.hasOwn(templates.context, name)) throw new Error(`Undeclared context ${name}`);
    const output = await readValue(resolve(dirname(file), item.output.from));
    const context = await Promise.all(Object.entries(item.context).map(async ([name, ref]) =>
      [name, await readValue(resolve(dirname(file), ref.from))] as const));
    return { id: item.id, output: output.value, context: Object.fromEntries(context.map(([name, loaded]) => [name, loaded.value])),
      refs: { output: output.reference, context: Object.fromEntries(context.map(([name, loaded]) => [name, loaded.reference])) } };
  }));
}
export async function readDecompositions(directory: string, templates: CheckTemplates, allowRejections = false) {
  const files = (await readdir(directory)).filter(file => file.endsWith('.decomposition.json')).sort();
  if (!files.length) throw new Error('No decomposition files');
  return Promise.all(files.map(async file => {
    const full = join(directory, file);
    const doc = parseDecomposition(JSON.parse(await readFile(full, 'utf8')));
    if (doc.rejected?.length && !allowRejections) throw new Error(`Decomposition has rejections; use --allow-rejections: ${file}`);
    const output = await readValue(resolve(directory, doc.output.from), doc.output.sha256);
    const context = await Promise.all(Object.entries(doc.context).map(async ([name, ref]) =>
      [name, await readValue(resolve(directory, ref.from), ref.sha256)] as const));
    const inputs = { output: output.value, context: Object.fromEntries(context.map(([name, loaded]) => [name, loaded.value])) };
    const validated = validateDecomposition(doc, inputs, templates);
    if (validated.rejected.length) throw new Error(`Invalid decomposition spans: ${file}`);
    return { file, doc, inputs, digest: stableDigest({ doc, templates }) };
  }));
}
export async function workers<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>, signal?: AbortSignal) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new Error('Invalid concurrency');
  let next = 0, failed = false;
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && next < items.length) {
      try { signal?.throwIfAborted(); await work(items[next++]!); }
      catch (error) { failed = true; throw error; }
    }
  }));
  const error = results.find(result => result.status === 'rejected');
  if (error?.status === 'rejected') throw error.reason;
}
