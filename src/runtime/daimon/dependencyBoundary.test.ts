import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { DAIMON_PACKAGE_NAME } from './packageName.js';

test('Spawnfile declares and locks no Daimon dependency', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    expect(manifest[section]?.[DAIMON_PACKAGE_NAME]).toBeUndefined();
  }
  expect(manifest.devDependencies['@noopolis/mneme']).toBe('^0.1.1');
  const lock = JSON.parse(await readFile(new URL('../../../package-lock.json', import.meta.url), 'utf8'));
  expect(Object.keys(lock.packages).filter(name => name.endsWith(`/node_modules/${DAIMON_PACKAGE_NAME}`) || name === `node_modules/${DAIMON_PACKAGE_NAME}`)).toEqual([]);
});
