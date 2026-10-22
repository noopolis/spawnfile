import { afterEach, describe, expect, it, vi } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runProcess } from '../platform/process/index.js';
import { cliFixture } from './fixture.js';

vi.mock('./launch.js', () => ({ launch: vi.fn(async () => undefined) }));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('executable command entry', () => {
  it('delegates the executable shim to the launch owner', async () => {
    const { launch } = await import('./launch.js');
    await import('./main.js');
    expect(launch).toHaveBeenCalledOnce();
  });
  it('runs the actual CLI process against real files and verifies positive output and malformed-input failure', async () => {
    const fixture = await cliFixture(); roots.push(fixture.root);
    const cli = resolve('src/cli/main.ts');
    const lines: string[] = [];
    const invoke = (file: string) => runProcess({ command: process.execPath,
      args: ['--import', 'tsx', cli, 'validate', file], cwd: process.cwd(), env: { PATH: process.env.PATH },
      stdin: '', timeoutMs: 10000, onLine: (line) => { lines.push(line); } }).completion;
    const passed = await invoke(join(fixture.root, 'data.yaml'));
    expect(passed.exitCode).toBe(0); expect(passed.error).toBeUndefined();
    expect(JSON.parse(lines.join(''))).toMatchObject({ status: 'valid', datasetId: 'example', records: 1 });
    await writeFile(join(fixture.root, 'broken.yaml'), 'schema: wrong');
    const rejected = await invoke(join(fixture.root, 'broken.yaml'));
    expect(rejected.exitCode).toBe(2); expect(rejected.stderr).toContain('schema');
  });
});
