import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { bridgeExecutionIdentity } from './index.js';
const bridgeLauncherBody = `# -*- coding: utf-8 -*-\nimport sys\nfrom paideia_dspy.main import cli\nif __name__ == "__main__":\n    if sys.argv[0].endswith("-script.pyw"):\n        sys.argv[0] = sys.argv[0][:-11]\n    elif sys.argv[0].endswith(".exe"):\n        sys.argv[0] = sys.argv[0][:-4]\n    sys.exit(cli())\n`;
const pipBridgeLauncherBody = `import sys\nfrom paideia_dspy.main import cli\nif __name__ == '__main__':\n    sys.argv[0] = sys.argv[0].removesuffix('.exe')\n    sys.exit(cli())\n`;
import { bridgeFixture as fixture } from './bridge-fixtures.js';


test('hashes actual installed bridge source and lock, excluding tests, cache and credentials', async () => {
  const f = await fixture();
  try {
    const first = await bridgeExecutionIdentity(f.root, f.context);
    const source = join(f.root, 'paideia_dspy/main.py');
    await writeFile(source, 'def cli(): return 1\n');
    const changed = await bridgeExecutionIdentity(f.root, f.context); assert.notEqual(changed, first);
    await writeFile(join(f.root, 'requirements.lock'), 'dspy==3.3.1\ngepa==0.1.4\n# revised pin metadata\n');
    const locked = await bridgeExecutionIdentity(f.root, f.context); assert.notEqual(locked, changed);
    await writeFile(join(f.root, 'paideia_dspy/main_test.py'), 'test source');
    await mkdir(join(f.root, 'paideia_dspy/__pycache__'), { recursive: true });
    await writeFile(join(f.root, 'paideia_dspy/__pycache__/generated.py'), 'generated cache');
    await symlink('/absent/auth', join(f.root, 'auth.json'));
    await writeFile(join(f.root, '.venv/ignored-generated.py'), 'generated');
    assert.equal(await bridgeExecutionIdentity(f.root, f.context), locked);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('refuses unrelated commands, wrapper changes and actual installed source mismatches', async () => {
  const f = await fixture();
  try {
    await assert.rejects(bridgeExecutionIdentity(undefined, f.context), /Explicit/);
    await assert.rejects(bridgeExecutionIdentity('relative', f.context), /Explicit/);
    await assert.rejects(bridgeExecutionIdentity(f.root, {}), /Explicit/);
    await assert.rejects(bridgeExecutionIdentity(f.root, { bridge: { command: '/other', cwd: f.root } }), /mismatched/);
    const original = await readFile(f.command);
    await writeFile(f.command, '#!/another/python\n' + bridgeLauncherBody);
    await assert.rejects(bridgeExecutionIdentity(f.root, f.context), /launcher/); await writeFile(f.command, original);
    const metadata = join(f.metadata, 'direct_url.json'); const saved = await readFile(metadata);
    await writeFile(metadata, JSON.stringify({ url: 'file:///unrelated', dir_info: { editable: true } }));
    await assert.rejects(bridgeExecutionIdentity(f.root, f.context), /differs/); await writeFile(metadata, saved);
    const other = join(f.root, 'unrelated'); await mkdir(join(other, 'paideia_dspy'), { recursive: true });
    await writeFile(join(other, 'paideia_dspy/__init__.py'), ''); await writeFile(join(f.site, 'bridge.pth'), other + '\n');
    await assert.rejects(bridgeExecutionIdentity(f.root, f.context), /differs/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('refuses Python overrides and unbounded or linked executable package sources', async () => {
  const f = await fixture();
  try {
    const previous = process.env.PYTHONPATH; process.env.PYTHONPATH = '/unrelated';
    try { await assert.rejects(bridgeExecutionIdentity(f.root, f.context), /overrides/); }
    finally { if (previous === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = previous; }
    await symlink('/absent', join(f.root, 'paideia_dspy/linked.py'));
    await assert.rejects(bridgeExecutionIdentity(f.root, f.context)); await rm(join(f.root, 'paideia_dspy/linked.py'));
    await symlink(f.root, join(f.root, 'paideia_dspy/linked_package'));
    await assert.rejects(bridgeExecutionIdentity(f.root, f.context), /symlinks/); await rm(join(f.root, 'paideia_dspy/linked_package'));
    const large = join(f.root, 'paideia_dspy/large.py'); await writeFile(large, ''); await truncate(large, 2 * 1024 * 1024 + 1);
    await assert.rejects(bridgeExecutionIdentity(f.root, f.context), /bounded/); await rm(large);
    await mkdir(join(f.root, 'paideia_dspy', ...Array.from({ length: 9 }, () => 'nested')), { recursive: true });
    await assert.rejects(bridgeExecutionIdentity(f.root, f.context), /depth/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});


test('accepts the exact pip Python3 launcher and still rejects mutated launchers or installed metadata', async () => {
  const f = await fixture();
  try {
    const uv = await bridgeExecutionIdentity(f.root, f.context);
    const launcher = `#!${join(f.root, '.venv/bin/python3')}\n${pipBridgeLauncherBody}`;
    await writeFile(f.command, launcher);
    const pip = await bridgeExecutionIdentity(f.root, f.context);
    assert.notEqual(pip, uv);
    await writeFile(f.command, launcher.replace('sys.exit(cli())', 'sys.exit(cli()) # changed'));
    await assert.rejects(bridgeExecutionIdentity(f.root, f.context), /launcher/);
    await writeFile(f.command, launcher);
    await writeFile(join(f.metadata, 'direct_url.json'), JSON.stringify({ url: 'file:///different', dir_info: { editable: true } }));
    await assert.rejects(bridgeExecutionIdentity(f.root, f.context), /differs/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('every independently reported interpreter and package identity must agree with the declared bridge', async () => {
  const { default: subprocess } = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const original = subprocess.execFile;
  const execute = promisify(original);
  const f = await fixture();
  try {
    const corruptions = [
      (value: { origin: string; search: string[]; prefix: string; interpreter: string; direct: { dir_info: { editable?: boolean } }; project: { name: string; scripts: Record<string, string> }; version: string }) => { value.origin = '/unrelated/__init__.py'; },
      (value: { origin: string; search: string[]; prefix: string; interpreter: string; direct: { dir_info: { editable?: boolean } }; project: { name: string; scripts: Record<string, string> }; version: string }) => { value.search = ['/unrelated']; },
      (value: { origin: string; search: string[]; prefix: string; interpreter: string; direct: { dir_info: { editable?: boolean } }; project: { name: string; scripts: Record<string, string> }; version: string }) => { value.prefix = '/unrelated/venv'; },
      (value: { origin: string; search: string[]; prefix: string; interpreter: string; direct: { dir_info: { editable?: boolean } }; project: { name: string; scripts: Record<string, string> }; version: string }) => { value.interpreter = '/unrelated/python'; },
      (value: { origin: string; search: string[]; prefix: string; interpreter: string; direct: { dir_info: { editable?: boolean } }; project: { name: string; scripts: Record<string, string> }; version: string }) => { value.direct.dir_info = {}; },
      (value: { origin: string; search: string[]; prefix: string; interpreter: string; direct: { dir_info: { editable?: boolean } }; project: { name: string; scripts: Record<string, string> }; version: string }) => { value.project.name = 'other-package'; },
      (value: { origin: string; search: string[]; prefix: string; interpreter: string; direct: { dir_info: { editable?: boolean } }; project: { name: string; scripts: Record<string, string> }; version: string }) => { value.version = '99'; },
      (value: { origin: string; search: string[]; prefix: string; interpreter: string; direct: { dir_info: { editable?: boolean } }; project: { name: string; scripts: Record<string, string> }; version: string }) => { value.project.scripts['paideia-dspy'] = 'other:main'; },
    ];
    for (const corrupt of corruptions) {
      const replacement = (() => { throw Error('Only the bounded promisified probe is expected'); }) as unknown as typeof original;
      Object.defineProperty(replacement, promisify.custom, { value: async (...args: Parameters<typeof execute>) => {
        const result = await execute(...args);
        const value = JSON.parse(String(result.stdout)); corrupt(value);
        return { ...result, stdout: JSON.stringify(value) };
      } });
      subprocess.execFile = replacement; syncBuiltinESMExports();
      await assert.rejects(bridgeExecutionIdentity(f.root, f.context), /differs/);
    }
  } finally { subprocess.execFile = original; syncBuiltinESMExports(); await rm(f.root, { recursive: true, force: true }); }
});

test('bounded bridge closure refuses aggregate oversize, excessive files and linked roots', async () => {
  const f = await fixture();
  try {
    const alias = f.root + '-alias'; await symlink(f.root, alias);
    try { await assert.rejects(bridgeExecutionIdentity(alias, f.context), /canonical/); }
    finally { await rm(alias); }
    const saved = await readFile(f.command); await rm(f.command); await symlink(f.python, f.command);
    await assert.rejects(bridgeExecutionIdentity(f.root, f.context), /mismatched/);
    await rm(f.command); await writeFile(f.command, saved);
    const pkg = join(f.root, 'paideia_dspy');
    await writeFile(join(pkg, 'ignored.json'), '{}');
    for (let i = 0; i < 4; i++) await writeFile(join(pkg, `large${i}.py`), Buffer.alloc(2 * 1024 * 1024));
    await assert.rejects(bridgeExecutionIdentity(f.root, f.context), /byte bound/);
    for (let i = 0; i < 4; i++) await rm(join(pkg, `large${i}.py`));
    await Promise.all(Array.from({ length: 257 }, (_, i) => writeFile(join(pkg, `file${i}.py`), '')));
    await assert.rejects(bridgeExecutionIdentity(f.root, f.context), /bounded/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
