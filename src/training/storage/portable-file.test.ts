import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { hasTrialEvalFile, writeTrialEvalFile } from './portable-file.js';

it('keeps concurrent trial files private and immutable under a confined name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'training-evals-'));
  try {
    const ids = ['abc', 'ABC', '../abc', '_abc'];
    expect(await hasTrialEvalFile(root, 'abc')).toBe(false);
    const names = await Promise.all(ids.map(id => writeTrialEvalFile(root, id, id)));
    expect(await hasTrialEvalFile(root, 'abc')).toBe(true);
    expect(new Set(names).size).toBe(ids.length);
    expect(names.slice(1)).toEqual(Array(3).fill(expect.stringMatching(/^evals\/_[a-f0-9]{64}\.eval$/u)));
    await expect(writeTrialEvalFile(root, 'abc', 'abc')).resolves.toBe('evals/abc.eval');
    await expect(writeTrialEvalFile(root, 'abc', 'changed')).rejects.toThrow('Immutable');
    expect(await readFile(join(root, names[0]!), 'utf8')).toBe('abc');
    expect(await readdir(join(root, 'evals'))).toHaveLength(ids.length);
    await symlink(join(root, 'elsewhere'), join(root, 'evals', 'redirect.eval'));
    await expect(writeTrialEvalFile(root, 'redirect', 'private')).rejects.toThrow('symlink');
    await mkdir(join(root, 'evals', 'directory.eval'));
    await expect(hasTrialEvalFile(root, 'directory')).rejects.toThrow('regular');
  } finally { await rm(root, { recursive: true, force: true }); }
});
