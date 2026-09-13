import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readSpawnfileContext } from './context.js';
import { contextFixture, inventoryDigest } from './fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('canonical Spawnfile source handoff', () => {
  it('verifies raw source pins up to the producer limit without decoding unselected sources', async () => {
    const f = await contextFixture(); roots.push(f.root);
    const bytes = Buffer.alloc(3 * 1024 * 1024, 0xff);
    const entry = { destinationPath: 'unselected.bin', sourcePath: join(f.root, 'unselected.bin'),
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
    await writeFile(entry.sourcePath, bytes);
    f.context.sources.push(entry);
    f.context.project.sourceDigest = inventoryDigest(f.context);
    await f.save();
    expect(readSpawnfileContext(f.path)).toEqual(f.context);
    await writeFile(entry.sourcePath, Buffer.alloc(16 * 1024 * 1024 + 1));
    expect(() => readSpawnfileContext(f.path)).toThrow('bounded regular');
  });
  it('verifies pinned source bytes, manifests, documents, skills and inventory digest', async () => {
    const f = await contextFixture(); roots.push(f.root);
    expect(readSpawnfileContext(f.path)).toEqual(f.context);
    await writeFile(join(f.root, 'AGENTS.md'), 'Changed after compiler extraction.');
    expect(() => readSpawnfileContext(f.path)).toThrow('source changed');
  });
  it('accepts confined aliases using exact raw pins and rejects changed target bytes', async () => {
    const f = await contextFixture(); roots.push(f.root);
    const alias = join(f.root, 'AGENTS.md'), target = join(f.root, 'actual-source.bin');
    await rename(alias, target);
    await symlink(target, alias);
    const bytes = Buffer.from([0xff, 0, 0xc3, 0x28, 0x0a]);
    await writeFile(target, bytes);
    const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    f.context.sources[0]!.sha256 = sha256;
    f.context.documents[0]!.sha256 = sha256;
    f.context.project.sourceDigest = inventoryDigest(f.context);
    await f.save();
    expect(readSpawnfileContext(f.path)).toEqual(f.context);
    await writeFile(target, Buffer.from([0xff, 0, 0xc3, 0x28]));
    expect(() => readSpawnfileContext(f.path)).toThrow('source changed');
  });
  it.each(['unsorted', 'duplicate', 'parent', 'empty-segment', 'absolute', 'backslash', 'mismatch', 'digest', 'document', 'skill', 'manifest', 'root', 'version'])(
    'rejects invalid receipt %s', async fault => {
      const f = await contextFixture(); roots.push(f.root);
      const first = f.context.sources[0]!;
      switch (fault) {
        case 'unsorted': f.context.sources.reverse(); break;
        case 'duplicate': f.context.sources.splice(1, 0, { ...first }); break;
        case 'parent': first.destinationPath = '../outside.md'; break;
        case 'empty-segment': first.destinationPath = 'a//b'; break;
        case 'absolute': first.destinationPath = '/outside.md'; break;
        case 'backslash': first.destinationPath = 'a\\b'; break;
        case 'mismatch': first.sourcePath = join(f.root, 'SOUL.md'); break;
        case 'digest': f.context.project.sourceDigest = `sha256:${'0'.repeat(64)}`; break;
        case 'document': f.context.documents[0]!.sha256 = `sha256:${'0'.repeat(64)}`; break;
        case 'skill': f.context.skills[0]!.destinationPath = 'absent.md'; break;
        case 'manifest': f.context.agent.source = join(f.root, 'missing'); break;
        case 'root': f.context.project.root = '.'; break;
        case 'version': Object.assign(f.context, { version: 'future' }); break;
      }
      await f.save();
      expect(() => readSpawnfileContext(f.path)).toThrow();
    });
  it('rejects a source redirected outside the project by a symlink', async () => {
    const f = await contextFixture(), other = await contextFixture(); roots.push(f.root, other.root);
    await rm(join(f.root, 'AGENTS.md'));
    await symlink(join(other.root, 'AGENTS.md'), join(f.root, 'AGENTS.md'));
    expect(() => readSpawnfileContext(f.path)).toThrow('escapes');
  });
});
