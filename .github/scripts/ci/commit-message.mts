// Commit messages: every authored commit is one Conventional Commits line with no body, trailers or attribution.
// Messages Git itself writes are accepted as Git wrote them (merges, `git revert`, `--fixup`/`--squash`). The same
// rules run in the local commit-msg hook (fast feedback) and in CI over a pull request's commits
// (the enforcement, since a hook can be skipped). Depends only on Node built-ins: CI runs it right after
// checkout, before any install.
//
//   node .github/scripts/ci/commit-message.mts <message-file>      check one message (the commit-msg hook)
//   node .github/scripts/ci/commit-message.mts --range <a>..<b>    check every commit in a range (CI)
//   node .github/scripts/ci/commit-message.mts --install           install the commit-msg hook into this clone (opt-in)
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const AUTHOR_EMAILS: readonly string[] = ['juancfortunatti@gmail.com'];

export const TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'] as const;
export const MAX_LENGTH = 150;
const CONVENTIONAL = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9._/-]+\\))?!?: \\S(.*\\S)?$`, 'u');
const ATTRIBUTION = /co-authored-by|generated (with|by)|🤖/iu;
const HOOK_SOURCE = '.github/hooks/commit-msg';
/** Where branches from before the hooks moved under `.github/` keep it; the shared dispatcher still runs theirs. */
const EARLIER_HOOK_SOURCE = '.githooks/commit-msg';
/** The opt-in hooks directory (`git config core.hooksPath .github/hooks`) and the one it replaced. */
const OPT_IN_HOOKS_PATH = '.github/hooks', EARLIER_HOOKS_PATH = '.githooks';
const HOOK_MARKER = 'commit-policy-commit-message-hook';

/** The message as Git stores it: comment lines and trailing blank lines removed (the default `strip` cleanup). */
export function cleanMessage(raw: string): string[] {
  const lines = raw.replace(/\r\n?/gu, '\n').split('\n').filter(line => !line.startsWith('#'));
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  while (lines.length && !lines[0]!.trim()) lines.shift();
  return lines;
}

/** Messages Git writes itself: a merge, `git revert`, and the `--fixup`/`--squash` autosquash markers. */
export function isGitGenerated(firstLine: string): boolean {
  return firstLine.startsWith('Merge ') || firstLine.startsWith('Revert "') ||
    /^(fixup|squash|amend)! /u.test(firstLine);
}

/** Why an authored message is rejected, or undefined when it is acceptable. */
export function messageProblem(raw: string): string | undefined {
  const lines = cleanMessage(raw), first = lines[0] ?? '';
  if (!first.trim()) return 'The message is empty.';
  if (isGitGenerated(first)) return undefined;
  if (lines.some(line => ATTRIBUTION.test(line))) return 'Remove attribution (Co-Authored-By, "Generated with …").';
  if (lines.length > 1) return 'Use a single line: no body and no trailers.';
  if (!CONVENTIONAL.test(first)) {
    return `Use Conventional Commits: <type>(<scope>)?!?: <summary>, with a lowercase type from ${TYPES.join(', ')}, and a scope of a-z, 0-9, ".", "_", "/" or "-" (no commas or spaces). Got: ${first}`;
  }
  if (first.length > MAX_LENGTH) return `Keep the line to ${MAX_LENGTH} characters; it has ${first.length}.`;
  return undefined;
}

export interface RangeCommit {
  readonly sha: string;
  readonly parents: number;
  readonly authorEmail: string;
  readonly message: string;
}

export function authorProblem(email: string): string | undefined {
  return AUTHOR_EMAILS.includes(email) ? undefined :
    `Author email must be ${AUTHOR_EMAILS.join(' or ')}; got ${email || '(empty)'}.`;
}

export function rangeProblems(commits: readonly RangeCommit[]): string[] {
  return commits.flatMap(commit => {
    // A merge's message is Git's own, whatever its text.
    const problem = authorProblem(commit.authorEmail) ??
      (commit.parents > 1 ? undefined : messageProblem(commit.message));
    return problem ? [`${commit.sha.slice(0, 10)} ${cleanMessage(commit.message)[0] ?? ''}\n  ${problem}`] : [];
  });
}

export async function commitsIn(range: string, root: string): Promise<RangeCommit[]> {
  const options = { cwd: root, maxBuffer: 1024 * 1024 * 64 };
  const { stdout } = await execFileAsync('git', ['log', '--format=%H', range, '--'], options);
  const commits: RangeCommit[] = [];
  // Read each message separately: user-controlled record separators cannot hide later commits.
  for (const sha of stdout.trim().split('\n').filter(Boolean)) {
    const { stdout: record } = await execFileAsync('git',
      ['show', '--no-patch', '--format=%P%x00%ae%x00%B', sha], options);
    const first = record.indexOf('\0'), second = record.indexOf('\0', first + 1);
    if (first < 0 || second < 0) throw new Error(`Cannot read commit ${sha}.`);
    commits.push({ sha, parents: record.slice(0, first).split(' ').filter(Boolean).length,
      authorEmail: record.slice(first + 1, second), message: record.slice(second + 1) });
  }
  return commits;
}

export async function currentAuthorEmail(root: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['var', 'GIT_AUTHOR_IDENT'], { cwd: root });
  const match = /<([^<>]*)> \d+ [+-]\d+\s*$/u.exec(stdout);
  if (!match) throw new Error('Cannot read the effective Git author identity.');
  return match[1]!;
}

/** The hooks directory `--install` owns, inside the clone's common Git directory, so every worktree shares it. */
export const HOOKS_DIRECTORY = 'commit-policy-hooks';

/** Runs the calling worktree's own tracked hook. It names no checker path, so it stays correct on every branch
 * layout, and it lives outside `.git/hooks`, which an older branch's installer overwrites. */
/** Marks a file this installer wrote into its hooks directory; nothing else there is ever overwritten. */
export const DISPATCHER_MARKER = 'commit-policy-commit-msg-dispatcher';
export const DISPATCHER = `#!/bin/sh
# ${HOOK_MARKER} ${DISPATCHER_MARKER}: run this worktree's tracked ${HOOK_SOURCE}. Installed explicitly.
root=$(git rev-parse --show-toplevel) || { echo "commit-msg: cannot find this worktree's top level; run git commit from inside the worktree." >&2; exit 1; }
hook="$root/${HOOK_SOURCE}"
[ -f "$hook" ] || [ ! -f "$root/${EARLIER_HOOK_SOURCE}" ] || hook="$root/${EARLIER_HOOK_SOURCE}"
[ -f "$hook" ] || { echo "commit-msg: $root/${HOOK_SOURCE} is missing; restore it (git checkout -- ${HOOK_SOURCE}), or skip once with git commit --no-verify." >&2; exit 1; }
exec sh "$hook" "$@"
`;

const git = async (root: string, ...args: string[]) => (await execFileAsync('git', args, { cwd: root })).stdout.trim();

/** Point this clone's core.hooksPath at a dispatcher that runs each worktree's own tracked hook. Git then never reads
 * `.git/hooks`, so a copy an older branch's installer writes there cannot replace the check; that installer also
 * returns early once core.hooksPath is set. Leaves any core.hooksPath already configured (including the pre-push
 * opt-in `.github/hooks`) and never disables a hook of the contributor's own in `.git/hooks`. */
export async function installHook(root: string): Promise<string> {
  let common: string, configured: string | undefined;
  try {
    common = resolve(root, await git(root, 'rev-parse', '--git-common-dir'));
    // `git config --get` fails when the key is unset; an explicitly empty value is a setting too, and is kept.
    configured = await git(root, 'config', '--get', 'core.hooksPath').catch(() => undefined);
  } catch {
    return 'Not a Git checkout; no hook installed.';
  }
  // Not `git rev-parse --git-path hooks`: that answers core.hooksPath once it is set.
  const legacy = resolve(common, 'hooks'), directory = resolve(common, HOOKS_DIRECTORY), target = resolve(directory, 'commit-msg');
  // The opt-in from before the hooks moved under `.github/` names a directory this layout no longer has, so Git would run
  // no hook at all. Carry the opt-in over to the directory that replaced it.
  if (configured !== undefined && resolve(root, configured) === resolve(root, EARLIER_HOOKS_PATH)
    && !existsSync(resolve(root, EARLIER_HOOKS_PATH)) && existsSync(resolve(root, OPT_IN_HOOKS_PATH))) {
    await git(root, 'config', 'core.hooksPath', OPT_IN_HOOKS_PATH);
    return `core.hooksPath was ${JSON.stringify(configured)}, which no longer exists; it is now ${JSON.stringify(OPT_IN_HOOKS_PATH)}.`;
  }
  if (configured !== undefined && (!configured || resolve(root, configured) !== directory)) return `core.hooksPath is ${JSON.stringify(configured)}; left unchanged (${HOOK_SOURCE} applies when that path is .github/hooks).`;
  if (configured === undefined) {
    const own: string[] = [];
    for (const name of await readdir(legacy).catch(() => [] as string[])) {
      if (name.endsWith('.sample')) continue;
      const text = await readFile(resolve(legacy, name), 'utf8').catch(() => '');
      if (!(name === 'commit-msg' && text.includes(HOOK_MARKER))) own.push(name);
    }
    if (own.length) return `${legacy} has hooks of your own (${own.join(', ')}); left unchanged. Set core.hooksPath to run ${HOOK_SOURCE}.`;
  }
  const current = await readFile(target, 'utf8').catch(() => undefined);
  if (current !== undefined && !current.includes(DISPATCHER_MARKER)) return `${target} is not this installer's dispatcher; left unchanged.`;
  await mkdir(directory, { recursive: true });
  await writeFile(target, DISPATCHER);
  await chmod(target, 0o755);
  await git(root, 'config', 'core.hooksPath', directory);
  // The copy an earlier install left in .git/hooks is no longer read; remove it so nothing looks installed twice.
  const copy = resolve(legacy, 'commit-msg');
  if ((await readFile(copy, 'utf8').catch(() => '')).includes(HOOK_MARKER)) await rm(copy, { force: true });
  return `Installed the commit-msg hook: core.hooksPath is ${directory}.`;
}

async function main(args: readonly string[]): Promise<number> {
  const root = resolve(import.meta.dirname, '../../..');
  if (args[0] === '--install' && args.length === 1) {
    console.log(`commit-message: ${await installHook(root)}`);
    return 0;
  }
  if (args[0] === '--range' && args.length === 2 && args[1]) {
    const problems = rangeProblems(await commitsIn(args[1], root));
    if (!problems.length) return 0;
    console.error(`Commit authors must be allowlisted; messages must be one Conventional Commits line with no attribution:\n${problems.join('\n')}\n` +
      'Reword them (git rebase -i, then "reword"), and see CONTRIBUTING.md#commits.');
    return 1;
  }
  if (args.length === 1 && args[0] && !args[0].startsWith('--')) {
    const problem = authorProblem(await currentAuthorEmail(root)) ??
      messageProblem(await readFile(args[0], 'utf8'));
    if (!problem) return 0;
    console.error(`commit-msg: ${problem}\nSee CONTRIBUTING.md#commits. Skip once with git commit --no-verify; CI still checks.`);
    return 1;
  }
  console.error('Usage: commit-message.mts <message-file> | --range <a>..<b> | --install');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`commit-message: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
