import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('rejects a real FIFO without waiting for a writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paideia-cli-fifo-')); roots.push(root);
  const fifo = join(root, 'input');
  await execute('mkfifo', [fifo], { timeout: 3000 });
  const script = `
    const {readCliBytes} = await import(process.argv[1]);
    process.stdout.write('entered-cli-read\\n');
    try { readCliBytes(process.argv[2], 1024); process.exitCode = 2; }
    catch (error) { process.stdout.write(JSON.stringify({error: error.message}) + '\\n'); }
  `;
  const result = await execute(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'),
    '--input-type=module', '--eval', script, new URL('./datasets.ts', import.meta.url).href, fifo],
  { timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 4096 });
  expect(result.stdout.split('\n')).toEqual(['entered-cli-read',
    JSON.stringify({ error: 'CLI input must be a bounded regular text file' }), '']);
});
