import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { materializeCandidate, snapshotCandidate, validateCandidate } from './index.js';
import { digestBytes } from './identity.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
it('detects actual installed-file corruption before returning a receipt', async () => {
  const root = await filesystem.mkdtemp(join(tmpdir(), 'paideia-install-'));
  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  try {
    await filesystem.writeFile(join(root, 'prompt.md'), 'Original prompt');
    const candidate = await snapshotCandidate({ sourceRoot: root, resources: [{ id: 'prompt', sourcePath: 'prompt.md', destinations: [{ kind: 'instructions', path: 'AGENTS.md' }], edit: 'whole-file' }] });
    vi.mocked(filesystem.open).mockImplementation(async (path, flags, mode) => {
      if (flags === 'r') await original.writeFile(path, 'Corrupted after installation');
      return original.open(path, flags, mode);
    });
    await expect(materializeCandidate(candidate, join(root, 'trial'))).rejects.toThrow(/Installed candidate bytes/);
  } finally { vi.mocked(filesystem.open).mockImplementation(original.open); await filesystem.rm(root, { recursive: true, force: true }); }
});
it('rejects aggregate candidate growth beyond the declared bound', async () => {
  const root = await filesystem.mkdtemp(join(tmpdir(), 'paideia-bound-'));
  try {
    await filesystem.writeFile(join(root, 'prompt.md'), 'Original prompt');
    const baseline = await snapshotCandidate({ sourceRoot: root, resources: [{ id: 'prompt', sourcePath: 'prompt.md', destinations: [{ kind: 'instructions', path: 'AGENTS.md' }], edit: 'whole-file' }] });
    const candidate = structuredClone(baseline);
    const content = 'x'.repeat(1_048_576);
    candidate.resources = Array.from({ length: 17 }, (_, index) => ({ ...candidate.resources[0]!, id: `r${index}`, sourcePath: `${index}.md`, destinations: [{ kind: 'supporting-files', path: `${index}.md` }], content, sourceContent: content, sourceDigest: digestBytes(content), digest: digestBytes(content) }));
    expect(() => validateCandidate(candidate)).toThrow(/16 MiB/);
  } finally { await filesystem.rm(root, { recursive: true, force: true }); }
});
