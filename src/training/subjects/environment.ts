import { access, mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export function savedCodexHome(selected?: string): string {
  return path.resolve(selected ?? process.env['CODEX_HOME'] ?? path.join(homedir(), '.codex'));
}

/** Authentication is selected externally and never copied or read into a capture. */
export async function prepareCodexEnvironment(
  workspacePath: string, runtimeHomePath: string, codexHome: string,
): Promise<NodeJS.ProcessEnv> {
  await access(path.join(codexHome, 'auth.json'));
  await Promise.all([workspacePath, runtimeHomePath].map((directory) => mkdir(directory, { recursive: true })));
  const [workspace, runtimeHome, authentication] = await Promise.all(
    [workspacePath, runtimeHomePath, codexHome].map((directory) => realpath(directory)),
  );
  if (within(workspace!, authentication!) || within(runtimeHome!, authentication!) ||
    within(authentication!, workspace!) || within(authentication!, runtimeHome!)) {
    throw new Error('Saved authentication must be outside subject workspace and runtime home');
  }
  await mkdir(path.join(runtimeHome!, '.tmp'), { recursive: true });
  return {
    PATH: process.env['PATH'], LANG: process.env['LANG'] ?? 'C', TZ: process.env['TZ'] ?? 'UTC',
    HOME: runtimeHome, CODEX_HOME: authentication,
    XDG_CONFIG_HOME: path.join(runtimeHome!, '.config'), XDG_CACHE_HOME: path.join(runtimeHome!, '.cache'),
    XDG_DATA_HOME: path.join(runtimeHome!, '.local/share'), XDG_STATE_HOME: path.join(runtimeHome!, '.local/state'),
    TMPDIR: path.join(runtimeHome!, '.tmp'),
  };
}

export async function canonicalProtectedPaths(paths: readonly string[] = []): Promise<string[]> {
  return Promise.all(paths.map(async (entry) => {
    if (!path.isAbsolute(entry)) throw new Error('Protected paths must be absolute existing paths');
    return realpath(entry);
  }));
}

export function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
