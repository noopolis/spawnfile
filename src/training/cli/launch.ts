import { main } from './commands.js';
import type { CliDependencies } from './types.js';

/** Shared signal/exit handling for installed project integrations as well as the plain CLI. */
export async function launch(argv = process.argv.slice(2), dependencies: CliDependencies = {}): Promise<void> {
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    process.exitCode = await main(argv, { cwd: process.cwd(), signal: controller.signal,
      stdout: (text) => { process.stdout.write(text); }, stderr: (text) => { process.stderr.write(text); } }, dependencies);
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
