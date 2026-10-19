import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export interface BridgeIdentityContext { bridge?: Readonly<{ command: string; cwd: string }> }

// Exact supported installed entry points. Arbitrary wrappers are not declared pinned.
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
const pipBridgeLauncherBody = `import sys
from paideia_dspy.main import cli
if __name__ == '__main__':
    sys.argv[0] = sys.argv[0].removesuffix('.exe')
    sys.exit(cli())
`;
const probe = `import importlib.util, importlib.metadata, json, pathlib, sys, tomllib
root = pathlib.Path(sys.argv[1]).resolve()
spec = importlib.util.find_spec('paideia_dspy')
dist = importlib.metadata.distribution('paideia-dspy-bridge')
project = tomllib.loads((root / 'pyproject.toml').read_text())['project']
print(json.dumps({'origin': spec.origin, 'search': list(spec.submodule_search_locations),
 'prefix': str(pathlib.Path(sys.prefix).resolve()), 'python': sys.version,
 'interpreter': str(pathlib.Path(sys.executable).resolve()),
 'version': dist.version, 'direct': json.loads(dist.read_text('direct_url.json')),
 'project': {'name': project['name'], 'version': project['version'], 'scripts': project['scripts']}}))`;

/** Bind the actual supported editable bridge, not an unrelated bundled source tree. */
export async function bridgeExecutionIdentity(root: string | undefined, context: BridgeIdentityContext): Promise<string> {
  if (!root || !isAbsolute(root) || !context.bridge || await realpath(root) !== root) throw new Error('Explicit canonical bridge root and actual bridge launch are required');
  const command = join(root, '.venv/bin/paideia-dspy');
  if (context.bridge.command !== command || await realpath(command) !== command) throw new Error('Unsupported or mismatched training bridge command');
  if (process.env.PYTHONPATH || process.env.PYTHONHOME) throw new Error('Python import overrides are unsupported for a pinned bridge');
  const digest = createHash('sha256').update('clank.paideia.python-bridge.v1\n');
  let files = 0, bytes = 0;
  const bind = async (path: string, label: string) => {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024 || ++files > 256) throw new Error('Bridge source is not a bounded regular file');
    const content = await readFile(path); bytes += content.length;
    if (bytes > 8 * 1024 * 1024) throw new Error('Bridge source closure exceeds its byte bound');
    digest.update(label).update('\0').update(content).update('\0'); return content;
  };
  const launcher = await bind(command, 'launcher');
  const supported = [
    { python: join(root, '.venv/bin/python'), body: bridgeLauncherBody },
    { python: join(root, '.venv/bin/python3'), body: pipBridgeLauncherBody },
  ].find(row => launcher.toString('utf8') === `#!${row.python}\n${row.body}`);
  if (!supported) throw new Error('Unsupported bridge launcher or interpreter binding');
  const { python } = supported;
  for (const file of ['pyproject.toml', 'requirements.lock']) await bind(join(root, file), file);
  const visit = async (directory: string, relative = '', depth = 0): Promise<void> => {
    if (depth > 8) throw new Error('Bridge source depth exceeds its bound');
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Bridge package must be a real directory');
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === '__pycache__' || entry.name.endsWith('_test.py') || entry.name.endsWith('.md')) continue;
      if (entry.isSymbolicLink()) throw new Error('Bridge source package symlinks are unsupported');
      const path = join(directory, entry.name), label = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(path, label, depth + 1);
      else if (entry.name.endsWith('.py')) await bind(path, `package${label}`);
    }
  };
  await visit(join(root, 'paideia_dspy'));
  // Inspection imports no bridge module or cognition, and does not read auth.
  // The supported console launcher has this directory as its import search root.
  const { stdout } = await promisify(execFile)(python, ['-c', probe, root], {
    cwd: join(root, '.venv/bin'), timeout: 10000, maxBuffer: 16384,
  });
  const actual = JSON.parse(stdout) as { origin: string; search: string[]; prefix: string; interpreter: string;
    python: string; version: string; direct: { url: string; dir_info?: { editable?: boolean } };
    project: { name: string; version: string; scripts: Record<string, string> } };
  if (actual.origin !== join(root, 'paideia_dspy/__init__.py') || JSON.stringify(actual.search) !== JSON.stringify([join(root, 'paideia_dspy')]) ||
      actual.prefix !== await realpath(join(root, '.venv')) || actual.interpreter !== await realpath(python) ||
      actual.direct.url !== pathToFileURL(root).href || actual.direct.dir_info?.editable !== true ||
      actual.project.name !== 'paideia-dspy-bridge' || actual.version !== actual.project.version || actual.project.scripts['paideia-dspy'] !== 'paideia_dspy.main:cli') {
    throw new Error('Installed bridge package, metadata or interpreter differs from its declared source');
  }
  digest.update(JSON.stringify(actual));
  return `clank.paideia.python-bridge.v1:sha256:${digest.digest('hex')}`;
}
