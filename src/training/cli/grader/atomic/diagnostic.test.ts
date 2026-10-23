import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runDecompose, runReference, runTraps } from './index.js';
import { fixture } from './fixtures.js';

it.each(['number-substitution', 'entity-substitution', 'negation-flip', 'citation-swap'])(
  'rejects removed %s mappings and saved variants before inference', async kind => {
    const f = await fixture();
    await runDecompose(f.decompose, f.dependencies);
    await runTraps(f.traps);
    f.generate.mockClear();
    const file = join(f.traps.out, (await readdir(f.traps.out))[0]!);
    const bundle = JSON.parse(await readFile(file, 'utf8'));
    bundle.traps[0].kind = kind;
    await writeFile(file, JSON.stringify(bundle));
    await expect(runReference(f.reference, f.dependencies)).rejects.toThrow('Invalid trap checkpoint');
    f.templates.templates[0]!.traps = { [kind]: 'unsupported' };
    await writeFile(f.templatesFile, JSON.stringify(f.templates));
    await expect(runTraps(f.traps)).rejects.toThrow();
    expect(f.generate).not.toHaveBeenCalled();
  },
);
