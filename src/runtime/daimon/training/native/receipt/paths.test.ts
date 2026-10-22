import { expect, test } from 'vitest';
import { link, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchFixture } from '../test-fixtures.js';
import { readPrivateFile, sha256, within } from './paths.js';

test('native bytes reject symlinks, hardlinks, directories and excessive size', async () => {
  const f = await launchFixture();
  try {
    expect(sha256('')).toHaveLength(64);
    expect(within('/a', '/a')).toBe(true); expect(within('/a', '/a/b')).toBe(true);
    expect(within('/a', '/b')).toBe(false); expect(within('/a/b', '/a')).toBe(false);
    expect(await readPrivateFile(f.launch.tokenFile)).toContain('unit-secret');
    await expect(readPrivateFile(f.launch.tokenFile, 2)).rejects.toThrow('oversized');
    const alias = join(f.root, 'alias'); await symlink(f.launch.tokenFile, alias);
    await expect(readPrivateFile(alias)).rejects.toThrow('Unsafe'); await rm(alias);
    await link(f.launch.tokenFile, alias); await expect(readPrivateFile(alias)).rejects.toThrow('Unsafe'); await rm(alias);
    await mkdir(alias); await expect(readPrivateFile(alias)).rejects.toThrow('Unsafe');
    await writeFile(join(f.root, 'empty'), ''); expect(await readPrivateFile(join(f.root, 'empty'))).toBe('');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
