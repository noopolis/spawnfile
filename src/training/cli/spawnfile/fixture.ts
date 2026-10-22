import { createHash } from 'node:crypto';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnfileTrainingContext } from './context.js';

export function inventoryDigest(context: SpawnfileTrainingContext): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(context.sources.map(({ destinationPath, sha256 }) => ({ destinationPath, sha256 })))).digest('hex')}`;
}

export async function contextFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'paideia-context-')));
  const files = { 'AGENTS.md': 'Write clearly.\n', 'SKILL.md': 'Check the evidence.\n', 'SOUL.md': 'An independent writer.\n', Spawnfile: 'agent: writer\n' };
  const sources = [];
  for (const [destinationPath, content] of Object.entries(files)) {
    const sourcePath = join(root, destinationPath);
    await writeFile(sourcePath, content);
    sources.push({ sourcePath, destinationPath, sha256: `sha256:${createHash('sha256').update(content).digest('hex')}` });
  }
  const context: SpawnfileTrainingContext = { version: 'spawnfile.training-context.v1',
    producer: { package: 'spawnfile', version: '0.1.17' },
    project: { root, manifest: join(root, 'Spawnfile'), sourceDigest: '' },
    agent: { id: 'agent:writer', name: 'writer', source: join(root, 'Spawnfile'), runtime: 'daimon', engine: 'codex',
      model: { provider: 'openai', name: 'gpt-5.5', authMethod: 'codex' } },
    sources, documents: [{ ...sources[0]!, role: 'system' }, { ...sources[2]!, role: 'soul' }],
    skills: [{ ...sources[1]!, name: 'evidence', ref: './SKILL.md', requiresMcp: [] }], resources: [],
    requirements: { nativeCompilation: true, isolatedPreparation: true } };
  context.project.sourceDigest = inventoryDigest(context);
  const path = join(root, 'context.json');
  const save = async () => writeFile(path, JSON.stringify(context));
  await save();
  return { root, path, context, save };
}
