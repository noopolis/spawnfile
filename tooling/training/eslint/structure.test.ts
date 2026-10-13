import { rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from 'vitest';
import { lintFixture } from './test-support.js';

test('real configuration warns above 400 lines and errors above 600', async () => {
  const fixture = await lintFixture();
  await fixture.guides('src/example');
  const source = (lines: number) => Array.from({ length: lines }, () => '// counted comments and blank lines').join('\n');
  expect(await fixture.lint(source(400))).toEqual([]);
  expect(await fixture.lint(`${source(400)}\n`)).toEqual([]);
  expect(await fixture.lint(`${source(401)}\n`)).toEqual([expect.objectContaining({ ruleId: 'structure/line-target', severity: 1 })]);
  expect(await fixture.lint(source(401))).toEqual([expect.objectContaining({ ruleId: 'structure/line-target', severity: 1 })]);
  expect(await fixture.lint(source(601))).toEqual(expect.arrayContaining([
    expect.objectContaining({ ruleId: 'max-lines', severity: 2 }),
    expect.objectContaining({ ruleId: 'structure/line-target', severity: 1 }),
  ]));
});

test('missing, empty, nonsymlink and redirected local guides fail at any implementation depth', async () => {
  const fixture = await lintFixture();
  const file = 'src/example/nested/file.ts';
  const violations = async () => (await fixture.lint('export const x = 1;', file)).filter((item) => item.ruleId === 'structure/directory-structure');
  expect(await violations()).toHaveLength(3);
  await fixture.guides('src/example/nested');
  expect(await violations()).toEqual([]);
  const dir = path.join(fixture.root, 'src/example/nested');
  await writeFile(path.join(dir, 'AGENTS.md'), ' ');
  expect(await violations()).toHaveLength(1);
  await fixture.guides('src/example/nested');
  await rm(path.join(dir, 'CLAUDE.md'));
  await writeFile(path.join(dir, 'CLAUDE.md'), '# Duplicate instructions');
  expect(await violations()).toHaveLength(1);
  await rm(path.join(dir, 'CLAUDE.md'));
  await symlink('../AGENTS.md', path.join(dir, 'CLAUDE.md'));
  expect(await violations()).toHaveLength(1);
  await rm(path.join(dir, 'CLAUDE.md'));
  await symlink('absent.md', path.join(dir, 'CLAUDE.md'));
  expect(await violations()).toHaveLength(1);
  await rm(path.join(dir, 'CLAUDE.md'));
  await symlink(path.join(dir, 'AGENTS.md'), path.join(dir, 'CLAUDE.md'));
  expect(await violations()).toHaveLength(1);
  await rm(path.join(dir, 'AGENTS.md'));
  await symlink('../AGENTS.md', path.join(dir, 'AGENTS.md'));
  expect(await violations()).toHaveLength(1);
});

test('directory budget counts all maintained direct files, excludes child directories and macOS metadata', async () => {
  const fixture = await lintFixture();
  await fixture.guides('tooling/checks');
  await fixture.file('tooling/checks/.DS_Store', 'metadata');
  for (let index = 0; index < 27; index++) await fixture.file(`tooling/checks/case-${index}.yaml`, 'schema: fixture');
  expect(await fixture.lint('export const x = 1;', 'tooling/checks/check.ts')).toEqual([]);
  await fixture.file('tooling/checks/overflow.md', 'one too many');
  expect(await fixture.lint('export const x = 1;', 'tooling/checks/check.ts')).toEqual([
    expect.objectContaining({ messageId: 'crowded', severity: 2 }),
  ]);
});

test('TypeScript restriction covers managed JavaScript while configuration entry points retain their required default export', async () => {
  const fixture = await lintFixture();
  await fixture.guides('viewer');
  expect(await fixture.lint('export const x = 1;', 'viewer/legacy.mjs')).toEqual([
    expect.objectContaining({ messageId: 'language', severity: 2 }),
  ]);
  expect(await fixture.lint('export const x = 1;', 'viewer/legacy.jsx')).toEqual([
    expect.objectContaining({ messageId: 'language', severity: 2 }),
  ]);
  expect(await fixture.lint('export default {};', 'example.config.ts')).toEqual([]);
  expect(await fixture.lint('export default {};', 'website/astro.config.ts')).toEqual([]);
  expect(await fixture.lint('export default {};', 'viewer/page.ts')).toEqual([
    expect.objectContaining({ ruleId: 'no-restricted-syntax', severity: 2 }),
  ]);
});

test('data-only directories cannot bypass layout checks by omitting TypeScript files', async () => {
  const fixture = await lintFixture();
  await fixture.guides('src/example');
  for (let index = 0; index < 31; index++) await fixture.file(`src/example/fixtures/case-${index}.yaml`, 'schema: test');
  expect(await fixture.lint('export const x = 1;')).toEqual(expect.arrayContaining([
    expect.objectContaining({ messageId: 'guide', message: expect.stringContaining('src/example/fixtures') }),
    expect.objectContaining({ messageId: 'crowded', message: expect.stringContaining('31 direct maintained files') }),
  ]));
});

test('a symlinked checkout retains required-guide checks', async () => {
  const fixture = await lintFixture({ aliasedCwd: true });
  expect((await fixture.lint('export const x = 1;')).filter((message) => message.messageId === 'guide')).toHaveLength(2);
});

test('generated dependencies and build output share the lint ignore policy; hidden implementation stays checked', async () => {
  const fixture = await lintFixture();
  await fixture.guides('viewer');
  for (const directory of ['dist', '.astro', 'node_modules', '.venv', 'coverage', '.runtime', '.paideia']) {
    await fixture.file(`viewer/${directory}/nested/generated.ts`);
  }
  expect(await fixture.lint('export const x = 1;', 'viewer/page.ts')).toEqual([]);
  await fixture.file('viewer/.internal/code.ts');
  expect(await fixture.lint('export const x = 1;', 'viewer/page.ts')).toEqual([
    expect.objectContaining({ messageId: 'guide', message: expect.stringContaining('viewer/.internal') }),
  ]);
});

test('worktree-local temporary caches are ignored by ESLint while maintained source is checked', async () => {
  const fixture = await lintFixture();
  expect(await fixture.lint('not valid JavaScript', '.tmp/jiti/generated.mjs')).toEqual([
    expect.objectContaining({ severity: 1, message: expect.stringContaining('ignored') }),
  ]);
  expect(await fixture.lint('not valid JavaScript', 'src/example/broken.ts')).toEqual([
    expect.objectContaining({ fatal: true, severity: 2 }),
  ]);
  expect(await fixture.lint('not valid JavaScript', 'src/.tmp/broken.ts')).toEqual([
    expect.objectContaining({ fatal: true, severity: 2 }),
  ]);
});
