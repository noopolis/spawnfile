import { mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { lintFixture } from './test-support.js';
import { canonicalPath, owner } from './paths.js';

async function fixture() {
  const result = await lintFixture();
  await result.guides('src/alpha/left');
  return { ...result, check: async (source: string, file = 'src/alpha/left/file.ts') =>
    (await result.lint(source, file)).filter((item) => item.ruleId === 'structure/module-boundaries') };
}

test('public indexes and shared contracts are permitted while owner and nested sibling internals fail', async () => {
  const f = await fixture();
  for (const source of [
    "import './private.js';", "import '../shared.js';", "import './nested/private.js';",
    "import '../../beta/index.js';", "export * from '../right/index.js';",
    "export type { Usage } from '../../contracts/execution.js';", "import 'node:path';",
    "import '../right';", "export const local = true;",
  ]) {
    if (source.includes("'../right'")) await f.file('src/alpha/right/index.ts');
    expect(await f.check(source)).toEqual([]);
  }
  for (const source of ["import '../../beta/private.js';", "export { x } from '../right/private.js';",
    "export * from '../right/private.js';", "await import('../../beta/private.js');", "require('../../beta/private.js');"]) {
    expect(await f.check(source)).toEqual([expect.objectContaining({ messageId: 'seam' })]);
  }
  expect(await f.check("import './alpha/private.js';", 'src/index.ts')).toEqual([expect.objectContaining({ messageId: 'seam' })]);
  expect(await f.check("import '../src/alpha/private.js';", 'viewer/page.ts')).toEqual([expect.objectContaining({ messageId: 'seam' })]);
});

test('repository escapes through relative, absolute, file URL and symlink imports fail', async () => {
  const f = await fixture();
  for (const source of ["import '../../../../sibling/private.js';", "import '/outside/private.js';",
    `import '${pathToFileURL('/outside/private.js').href}';`, "import 'file://other-host/private.js';"]) {
    expect(await f.check(source)).toEqual([expect.objectContaining({ messageId: 'escape' })]);
  }
  await symlink('/etc/hosts', path.join(f.root, 'src/alpha/left/linked.ts'));
  expect(await f.check("import './linked.js';")).toEqual([expect.objectContaining({ messageId: 'escape' })]);
  await f.file('src/alpha/left/exact.ts');
  expect(await f.check("import './exact.ts';")).toEqual([]);
  await f.file('src/alpha/left/no-extension.ts');
  expect(await f.check("import './no-extension';")).toEqual([]);
  await symlink('/etc/hosts', path.join(f.root, 'src/alpha/left/module.mts'));
  expect(await f.check("import './module.mjs';")).toEqual([expect.objectContaining({ messageId: 'escape' })]);
  await mkdir(path.join(f.root, 'docs'));
  expect(await f.check("import '../../../docs/data.js';")).toEqual([]);
});

test('core stays neutral and optional runtime integration remains behind its owning adapter', async () => {
  const f = await fixture();
  expect(await f.check("import '../adapters/index.js';", 'src/evaluation/engine.ts')).toEqual([
    expect.objectContaining({ messageId: 'neutral' }),
  ]);
  for (const specifier of ['spawnfile', 'simfile/internal', '@noopolis/mneme', '@noopolis/daimon/pi', '@noopolis/daimon/internal']) {
    expect(await f.check(`import '${specifier}';`)).toEqual([expect.objectContaining({ messageId: 'runtime' })]);
  }
  expect(await f.check("const packageName = '@noopolis/daimon/pi'; export async function load() { return import(packageName); }",
    'src/adapters/daimon/public.ts')).toEqual([]);
  expect(await f.check("import '../cases/index.js';", 'src/evaluation/engine.ts')).toEqual([]);
  expect(await f.check("import '../index.js';", 'src/evaluation/engine.ts')).toEqual([expect.objectContaining({ messageId: 'neutral' })]);
  expect(await f.check("import '../../contracts/private/implementation.js';")).toEqual([expect.objectContaining({ messageId: 'seam' })]);
});

test('computed imports fail closed; lexical constant literals are checked like static imports', async () => {
  const f = await fixture();
  for (const source of [
    'await import(unknownPackage);', 'require();', "let name = './private.js'; await import(name);",
    "const name = './private' + '.js'; await import(name);", 'await import(`./private.js`);',
    "function get() { return './private.js'; } await import(get());",
  ]) expect(await f.check(source)).toEqual([expect.objectContaining({ messageId: 'dynamic' })]);
  expect(await f.check("const name = '../../beta/private.js'; await import(name);")).toEqual([expect.objectContaining({ messageId: 'seam' })]);
  expect(await f.check("const name = './private.js'; export function load() { return import(name); }")).toEqual([]);
  expect(await f.check("export function local() { return 1; } local();")).toEqual([]);
  expect(await f.check("import '#private';")).toEqual([expect.objectContaining({ messageId: 'alias' })]);
  expect(await f.check("import privateModule = require('../../beta/private.js');")).toEqual([expect.objectContaining({ messageId: 'seam' })]);
  expect(await f.check("/// <reference path='../../beta/private.ts' />\nexport const x = true;")).toEqual([expect.objectContaining({ messageId: 'seam' })]);
  for (const source of [
    "// see <reference path='../../beta/private.ts' />\nexport const x = true;",
    "/* <reference path='../../beta/private.ts' /> */\nexport const x = true;",
    "export const x = true;\n/// <reference path='../../beta/private.ts' />",
  ]) expect(await f.check(source)).toEqual([]);
  expect(await f.check("namespace Local { export const x = 1; } import Alias = Local.x;")).toEqual([]);
});

test('new unsaved paths remain absolute and unowned paths do not acquire a module', async () => {
  expect(canonicalPath('./a-file-that-does-not-exist')).toBe(path.resolve('./a-file-that-does-not-exist'));
  expect(owner([])).toBeUndefined();
});
