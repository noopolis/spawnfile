import { afterEach, expect, it, vi } from 'vitest';
import { access, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from './commands.js';
import { cliFixture } from './fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.each(['validate', 'evaluate', 'train', 'dry-run'] as const)(
  '%s rejects malformed inline and protected sidecar schemas before factory construction or cost output', async mode => {
    for (const schema of [{ type: 'wrong' }, { type: 'object', requried: ['title'] }, { $ref: '#/$defs/missing' }, 'schema.json', 'bom.json']) {
      const f = await cliFixture(); roots.push(f.root);
      for (const [name, groups] of [['train', ['a', 'b']], ['test', ['x']]] as const) {
        await writeFile(join(f.root, `${name}.yaml`), JSON.stringify({ schema: 'paideia.dataset.v1', id: name,
          checks: [{ id: 'shape', eval: 'json-schema', input: 'output.text', schema }],
          records: groups.map(id => ({ id, group: id, input: { prompt: 'Reply' } })) }));
      }
      await writeFile(join(f.root, 'schema.json'), '{"$ref":"#/$defs/missing"}');
      await writeFile(join(f.root, 'bom.json'), '\uFEFF{"type":"object"}');
      const adapter = vi.fn(() => { throw new Error('Unexpected adapter construction'); });
      const inference = vi.fn(() => { throw new Error('Unexpected inference construction'); });
      const argv = mode === 'validate' ? ['validate', 'train.yaml'] : mode === 'evaluate'
        ? ['evaluate', 'train.yaml', ...f.nativeArgs]
        : ['train', '--train', 'train.yaml', '--test', 'test.yaml', ...f.nativeArgs,
          '--editable', 'AGENTS.md', '--optimizer-model', 'explicit-fixture', '--bridge-command', f.bridge,
          ...(mode === 'dry-run' ? ['--dry-run'] : [])];
      expect(await main(argv, f.io, { adapter, inference })).toBe(2);
      expect(adapter).not.toHaveBeenCalled(); expect(inference).not.toHaveBeenCalled();
      expect(f.stdout).toEqual([]);
      expect(f.stderr.join('')).not.toMatch(/Unexpected (adapter|inference) construction/);
      await expect(access(join(f.root, 'out'))).rejects.toThrow();
    }
  });
