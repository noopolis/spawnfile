import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveAuthoredCandidate, snapshotCandidate } from './index.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'authored-')); roots.push(root);
  await writeFile(join(root, 'AGENTS.md'), '# Identity\r\nLocked.\r\n\r\n## Craft\r\nOld.\r\n');
  await writeFile(join(root, 'SOUL.md'), 'Locked soul.');
  return snapshotCandidate({ sourceRoot: root, resources: [
    { id: 'instructions', sourcePath: 'AGENTS.md', destinations: [{ kind: 'instructions', path: 'AGENTS.md' }], edit: { headings: [['Identity','Craft']] } },
    { id: 'soul', sourcePath: 'SOUL.md', destinations: [{ kind: 'supporting-files', path: 'SOUL.md' }], edit: 'locked' },
  ] });
}
it('preserves exact complete file bytes and locked source while validating section edits', async () => {
  const baseline = await fixture();
  const text = baseline.resources[0]!.content.replace('Old.', 'New with trailing spaces.  ');
  const candidate = deriveAuthoredCandidate(baseline, { 'AGENTS.md': text });
  expect(candidate.resources[0]!.content).toBe(text);
  expect(candidate.resources[1]).toEqual(baseline.resources[1]);
  expect(candidate.parentId).toBe(baseline.id); expect(candidate.baselineId).toBe(baseline.id);
  expect(candidate.policyDigest).toBe(baseline.policyDigest); expect(Object.isFrozen(candidate)).toBe(true);
  expect(baseline.resources[0]!.content).toContain('Old.');
  const rejected: Record<string, string>[] = [{}, { 'SOUL.md': 'changed' }, { absent: 'changed' },
    { 'AGENTS.md': 3 as unknown as string }, { 'AGENTS.md': baseline.resources[0]!.content },
    { 'AGENTS.md': text.replace('Locked.', 'UNLOCKED') }, { 'AGENTS.md': text + '\0' }, { 'AGENTS.md': 'x'.repeat(1_048_577) }];
  for (const replacements of rejected) {
    expect(() => deriveAuthoredCandidate(baseline, replacements)).toThrow();
  }
});
