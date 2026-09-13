import { main } from './commands.js';

export async function launch(argv = process.argv.slice(2)): Promise<void> {
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    process.exitCode = await main(argv, { cwd: process.cwd(), signal: controller.signal,
      stdout: (text) => { process.stdout.write(text); }, stderr: (text) => { process.stderr.write(text); } });
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
