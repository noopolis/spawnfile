import { expect, it, vi } from 'vitest';

// Fixed installed-source/metadata inputs pin the renamed bridge algorithm, independent
// of the host Python version and temporary installation path.
vi.mock('node:fs/promises', () => ({
  realpath: async (path: string) => path,
  lstat: async () => ({ isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false, size: 100 }),
  readdir: async () => ['__init__.py', 'legacy_wire_aliases.json'].map(name => ({ name, isSymbolicLink: () => false, isDirectory: () => false })),
  readFile: async (path: string) => Buffer.from(path.endsWith('spawnfile-training-dspy')
    ? '#!/fixture/.venv/bin/python\n# -*- coding: utf-8 -*-\nimport sys\nfrom spawnfile_training_dspy.main import cli\nif __name__ == "__main__":\n    if sys.argv[0].endswith("-script.pyw"):\n        sys.argv[0] = sys.argv[0][:-11]\n    elif sys.argv[0].endswith(".exe"):\n        sys.argv[0] = sys.argv[0][:-4]\n    sys.exit(cli())\n'
    : `fixture:${path}\n`),
}));
vi.mock('node:child_process', () => ({
  execFile: (_command: string, _args: string[], _options: unknown, callback: (...args: unknown[]) => void) => {
    callback(null, { stdout: JSON.stringify({ origin: '/fixture/spawnfile_training_dspy/__init__.py', search: ['/fixture/spawnfile_training_dspy'],
      prefix: '/fixture/.venv', interpreter: '/fixture/.venv/bin/python', python: '3.fixture', version: '0.1.0',
      direct: { url: 'file:///fixture', dir_info: { editable: true } },
      project: { name: 'spawnfile-training-dspy-bridge', version: '0.1.0', scripts: { 'spawnfile-training-dspy': 'spawnfile_training_dspy.main:cli' } },
    }) });
  },
}));
import { bridgeExecutionIdentity } from './bridge-identity.js';

it('pins the training bridge identity namespace and exact hash domain', async () => {
  const context = { bridge: { command: '/fixture/.venv/bin/spawnfile-training-dspy', cwd: '/fixture' } };
  const previous = process.env.PYTHONPATH; delete process.env.PYTHONPATH;
  try {
    // Computed against the fixed installed-source and metadata inputs above.
    expect(await bridgeExecutionIdentity('/fixture', context)).toBe(
      'spawnfile.training.python-bridge.v1:sha256:3d803724c060946bc4f0a6abb162cdbf66cbce2fb79b0e2c79f2155990c88427');
  } finally { if (previous !== undefined) process.env.PYTHONPATH = previous; }
});
