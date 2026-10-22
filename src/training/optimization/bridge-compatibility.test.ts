import { expect, it, vi } from 'vitest';

// Fixed installed-source/metadata inputs pin the old private algorithm, independent
// of the host Python version and temporary installation path.
vi.mock('node:fs/promises', () => ({
  realpath: async (path: string) => path,
  lstat: async () => ({ isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false, size: 100 }),
  readdir: async () => [{ name: '__init__.py', isSymbolicLink: () => false, isDirectory: () => false }],
  readFile: async (path: string) => Buffer.from(path.endsWith('paideia-dspy')
    ? '#!/fixture/.venv/bin/python\n# -*- coding: utf-8 -*-\nimport sys\nfrom paideia_dspy.main import cli\nif __name__ == "__main__":\n    if sys.argv[0].endswith("-script.pyw"):\n        sys.argv[0] = sys.argv[0][:-11]\n    elif sys.argv[0].endswith(".exe"):\n        sys.argv[0] = sys.argv[0][:-4]\n    sys.exit(cli())\n'
    : `fixture:${path}\n`),
}));
vi.mock('node:child_process', () => ({
  execFile: (_command: string, _args: string[], _options: unknown, callback: (...args: unknown[]) => void) => {
    callback(null, { stdout: JSON.stringify({ origin: '/fixture/paideia_dspy/__init__.py', search: ['/fixture/paideia_dspy'],
      prefix: '/fixture/.venv', interpreter: '/fixture/.venv/bin/python', python: '3.fixture', version: '0.1.0',
      direct: { url: 'file:///fixture', dir_info: { editable: true } },
      project: { name: 'paideia-dspy-bridge', version: '0.1.0', scripts: { 'paideia-dspy': 'paideia_dspy.main:cli' } },
    }) });
  },
}));
import { bridgeExecutionIdentity } from './bridge-identity.js';

it('preserves the private bridge identity namespace and exact hash domain', async () => {
  const context = { bridge: { command: '/fixture/.venv/bin/paideia-dspy', cwd: '/fixture' } };
  const previous = process.env.PYTHONPATH; delete process.env.PYTHONPATH;
  try {
    // Computed by the original private reader against the fixed inputs above.
    expect(await bridgeExecutionIdentity('/fixture', context)).toBe(
      'clank.paideia.python-bridge.v1:sha256:019392a90da7ba1e82527c069770b4180bfe23b370712d3bb22efdb4be1e49ca');
  } finally { if (previous !== undefined) process.env.PYTHONPATH = previous; }
});
