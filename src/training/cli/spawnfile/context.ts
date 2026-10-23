import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { readCliBytes, readCliText } from '../datasets.js';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const text = z.string().min(1);
const source = z.object({ sourcePath: text, destinationPath: text, sha256: digest }).strict();
const schema = z.object({ version: z.literal('spawnfile.training-context.v1'),
  producer: z.object({ package: z.literal('spawnfile'), version: text }).strict(),
  project: z.object({ root: text, manifest: text, sourceDigest: digest }).strict(),
  agent: z.object({ id: text, name: text, source: text, runtime: text, engine: text.nullable(),
    model: z.object({ provider: text, name: text, authMethod: text }).strict().nullable() }).strict(),
  sources: z.array(source).min(1).max(10000),
  documents: z.array(source.extend({ role: text }).strict()).max(128),
  skills: z.array(source.extend({ name: text, ref: text, requiresMcp: z.array(text) }).strict()).max(1000),
  resources: z.array(z.object({ id: text, kind: z.enum(['bundle', 'git', 'volume']), mount: text,
    mode: z.enum(['mutable', 'readonly']), sharing: z.enum(['per_agent', 'team']),
    definitionDigest: digest, pin: text.nullable() }).strict()).max(1000),
  requirements: z.object({ nativeCompilation: z.literal(true), isolatedPreparation: z.literal(true) }).strict(),
}).strict();
export type SpawnfileTrainingContext = z.infer<typeof schema>;

/** Recheck canonical bytes; the temporary receipt alone is not proof its sources still match. */
export function readSpawnfileContext(path: string): SpawnfileTrainingContext {
  const context = schema.parse(JSON.parse(readCliText(path, 2_000_000)));
  const root = context.project.root;
  if (!isAbsolute(root) || realpathSync(root) !== root) throw new Error('Spawnfile project root must be canonical and absolute');
  const entries = new Map<string, typeof context.sources[number]>();
  let previous: string | undefined;
  for (const entry of context.sources) {
    const destination = entry.destinationPath;
    if (previous !== undefined && previous >= destination) throw new Error('Spawnfile sources must have unique sorted destinations');
    previous = destination;
    if (isAbsolute(destination) || destination.includes('\\') || destination.split('/').some(segment => ['', '.', '..'].includes(segment))) {
      throw new Error('Spawnfile source destination must be a confined project-relative path');
    }
    const expected = resolve(root, destination);
    const canonical = realpathSync(expected);
    const within = relative(root, canonical);
    if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`) || entry.sourcePath !== expected) {
      throw new Error('Spawnfile source mapping escapes or differs from its canonical project path');
    }
    const actual = `sha256:${createHash('sha256').update(readCliBytes(canonical, 16 * 1024 * 1024)).digest('hex')}`;
    if (actual !== entry.sha256) throw new Error(`Spawnfile source changed: ${destination}`);
    entries.set(destination, entry);
  }
  const actualDigest = `sha256:${createHash('sha256').update(JSON.stringify(context.sources.map(({ destinationPath, sha256 }) => ({ destinationPath, sha256 })))).digest('hex')}`;
  if (actualDigest !== context.project.sourceDigest) throw new Error('Spawnfile project source digest does not match its pinned inventory');
  for (const document of [...context.documents, ...context.skills]) {
    const selected = entries.get(document.destinationPath);
    if (!selected || selected.sourcePath !== document.sourcePath || selected.sha256 !== document.sha256) throw new Error('Spawnfile document or skill is not pinned in the source inventory');
  }
  for (const manifest of [context.project.manifest, context.agent.source]) {
    if (!context.sources.some(entry => entry.sourcePath === manifest)) throw new Error('Spawnfile manifest is not pinned in the source inventory');
  }
  return context;
}
