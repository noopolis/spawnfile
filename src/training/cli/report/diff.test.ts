import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unifiedDiff } from './diff.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const run = promisify(execFile);
it('does not manufacture a change for identical bytes', () => { expect(unifiedDiff('a.md', 'same', 'same')).toBe(''); });
it.each([
  ['empty insertion', '', 'new\n'], ['empty deletion', 'old\n', ''], ['replacement', 'old\n', 'new\n'],
  ['missing final newline', 'old', 'new'], ['newline added', 'same', 'same\n'], ['newline removed', 'same\n', 'same'],
  ['CRLF preserved', 'old\r\nend\r\n', 'new\r\nend\r\n'],
  ['context and separated changes', 'a\nb\nc\nd\ne\nf\ng\nh\ni\n', 'a\nB\nc\nd\ne\nf\ng\nH\ni\n'],
  ['end insertion', 'a\nb\nc\nd\ne\nf\ng\n', 'a\nb\nc\nd\ne\nf\ng\nnew\n'],
  ['trailing context', 'a\nb\nc\nd\ne\nf\ng\n', 'a\nB\nc\nd\ne\nf\ng\n'],
])('emits an applicable byte-faithful unified patch: %s', async (_name, before, after) => {
  const root = await mkdtemp(join(tmpdir(), 'paideia-diff-')); roots.push(root);
  const path = 'file with "quotes"\tand-é.md';
  await writeFile(join(root, path), before!);
  const patch = join(root, 'candidate.diff');
  await writeFile(patch, unifiedDiff(path, before!, after!));
  await run('git', ['apply', '--check', patch], { cwd: root });
  await run('git', ['apply', patch], { cwd: root });
  expect(await readFile(join(root, path), 'utf8')).toBe(after);
});
