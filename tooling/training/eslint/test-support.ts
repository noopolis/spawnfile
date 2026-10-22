import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ESLint, type Linter } from 'eslint';
import { afterEach } from 'vitest';
import config from '../../eslint.config.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

export async function lintFixture(options: { aliasedCwd?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'paideia-eslint-'));
  roots.push(root);
  async function file(relative: string, text = 'export const fixture = true;') {
    const filename = path.join(root, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, text);
    return filename;
  }
  async function guides(relative: string) {
    let directory = path.join(root, relative);
    while (directory !== root) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'AGENTS.md'), '# Focused implementation guide\n');
      if (!existsSync(path.join(directory, 'CLAUDE.md'))) await symlink('AGENTS.md', path.join(directory, 'CLAUDE.md'));
      directory = path.dirname(directory);
    }
  }
  const cwd = options.aliasedCwd ? path.join(root, 'checkout-alias') : root;
  if (options.aliasedCwd) await symlink(root, cwd);
  // typescript-eslint's configuration type predates ESLint 10's language index signature.
  const eslint = new ESLint({ cwd, overrideConfigFile: true, overrideConfig: config as unknown as Linter.Config[] });
  async function lint(code: string, relative = 'src/example/file.ts') {
    const filename = await file(relative, code);
    // ESLint ignores physical paths outside its lexical cwd before rules run.
    const filePath = options.aliasedCwd ? path.join(cwd, relative) : filename;
    return (await eslint.lintText(code, { filePath }))[0]!.messages;
  }
  return { root, file, guides, lint };
}
