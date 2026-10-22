import { pathToFileURL } from 'node:url';
import { runDaimonNativeWorker } from './worker.js';

export async function nativeWorkerMain(args: string[]): Promise<number> {
  try { await runDaimonNativeWorker(args); return 0; }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ schema: 'paideia.daimon-native.start-failed.v1',
      error: error instanceof Error ? error.message : 'Native startup failed' })}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void nativeWorkerMain(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
