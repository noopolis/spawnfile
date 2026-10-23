import { afterEach, describe, expect, it, vi } from 'vitest';
import { rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runProcess } from '../training/platform/process/index.js';
import { cliFixture } from '../training/cli/fixture.js';

vi.mock('../training/cli/index.js', () => ({ launch: vi.fn(async () => undefined) }));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('executable command entry', () => {
  it('imports the composition without starting a CLI', async () => {
    const { launch } = await import('../training/cli/index.js');
    await import('./trainingCli.js');
    expect(launch).not.toHaveBeenCalled();
  });
  it('runs the actual CLI process against real files and verifies positive output and malformed-input failure', async () => {
    const fixture = await cliFixture(); roots.push(fixture.root);
    const cli = resolve('src/runtime/trainingCli.ts');
    const lines: string[] = [];
    const invoke = (file: string, entry = cli) => runProcess({ command: process.execPath,
      args: ['--import', 'tsx', entry, 'validate', file], cwd: process.cwd(), env: { PATH: process.env.PATH },
      stdin: '', timeoutMs: 10000, onLine: (line) => { lines.push(line); } }).completion;
    const passed = await invoke(join(fixture.root, 'data.yaml'));
    expect(passed.exitCode).toBe(0); expect(passed.error).toBeUndefined();
    expect(JSON.parse(lines.join(''))).toMatchObject({ status: 'valid', datasetId: 'example', records: 1 });
    const linked = join(fixture.root, 'training-cli.ts');
    await symlink(cli, linked);
    lines.length = 0;
    const linkedResult = await invoke(join(fixture.root, 'data.yaml'), linked);
    expect(linkedResult.exitCode).toBe(0);
    expect(JSON.parse(lines.join(''))).toMatchObject({ status: 'valid', records: 1 });
    await writeFile(join(fixture.root, 'broken.yaml'), 'schema: wrong');
    const rejected = await invoke(join(fixture.root, 'broken.yaml'));
    expect(rejected.exitCode).toBe(2); expect(rejected.stderr).toContain('schema');
  });
});
