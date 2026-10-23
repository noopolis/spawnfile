import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';

/** Freeze PATH selection before integration identity and launch consume the same executable. */
export async function resolveTrainingBridgeCommand(command: string, cwd: string): Promise<string> {
  // Explicit paths retain their authored binding; pinned integrations reject aliases themselves.
  if (command.includes('/')) return resolve(cwd, command);
  const searchPath = process.env.PATH;
  if (searchPath === undefined) throw new Error('Training bridge executable is unavailable');
  const candidates = searchPath.split(delimiter).map(directory => resolve(cwd, directory, command));
  for (const candidate of candidates) {
    try {
      const executable = await realpath(candidate);
      if (!(await stat(executable)).isFile()) continue;
      await access(executable, constants.X_OK);
      return executable;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  throw new Error('Training bridge executable is unavailable');
}
