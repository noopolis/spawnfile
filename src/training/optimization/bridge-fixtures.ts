import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
const bridgeLauncherBody = `# -*- coding: utf-8 -*-
import sys
from paideia_dspy.main import cli
if __name__ == "__main__":
    if sys.argv[0].endswith("-script.pyw"):
        sys.argv[0] = sys.argv[0][:-11]
    elif sys.argv[0].endswith(".exe"):
        sys.argv[0] = sys.argv[0][:-4]
    sys.exit(cli())
`;

// Real isolated editable Python installation, with no DSPy download or cognition.
export async function bridgeFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'bridge-identity-')));
  const python = join(root, '.venv/bin/python'), command = join(root, '.venv/bin/paideia-dspy');
  const execute = promisify(execFile);
  await execute('python3', ['-m', 'venv', '--without-pip', join(root, '.venv')]);
  const { stdout } = await execute(python, ['-c', 'import sysconfig; print(sysconfig.get_paths()["purelib"])']);
  const site = stdout.trim();
  const metadata = join(site, 'paideia_dspy_bridge-0.1.0.dist-info'); await mkdir(metadata);
  await writeFile(join(metadata, 'METADATA'), 'Metadata-Version: 2.1\nName: paideia-dspy-bridge\nVersion: 0.1.0\n');
  await writeFile(join(metadata, 'direct_url.json'), JSON.stringify({ url: pathToFileURL(root).href, dir_info: { editable: true } }));
  await writeFile(join(site, 'bridge.pth'), root + '\n');
  await mkdir(join(root, 'paideia_dspy'));
  await writeFile(join(root, 'paideia_dspy/__init__.py'), '"""Fixture package; no cognition."""\n');
  await writeFile(join(root, 'paideia_dspy/main.py'), 'def cli(): pass\n');
  await writeFile(join(root, 'pyproject.toml'), '[project]\nname = "paideia-dspy-bridge"\nversion = "0.1.0"\n[project.scripts]\npaideia-dspy = "paideia_dspy.main:cli"\n');
  await writeFile(join(root, 'requirements.lock'), 'dspy==3.3.1\ngepa==0.1.4\n');
  await writeFile(command, `#!${python}\n${bridgeLauncherBody}`); await chmod(command, 0o755);
  return { root, command, python, metadata, site, context: { bridge: { command, cwd: root } } };
}

