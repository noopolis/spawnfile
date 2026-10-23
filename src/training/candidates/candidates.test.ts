import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CandidateManifest, ResourceMapping } from './types.js';
import { candidateComponents, deriveCandidate, materializeCandidate, snapshotCandidate, validateCandidate } from './index.js';
import { candidateIdentity, digestBytes, freezeCandidate, policyIdentity } from './identity.js';
import { containedPath, relativeResourcePath } from './filesystem.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const instructions = '# Agent\r\n\r\nIdentity stays.\r\n\r\n## Craft\r\n\r\nOld prose.\r\n\r\n## Policy\r\n\r\nNever browse.\r\n';
const mapping: ResourceMapping[] = [
  { id: 'instructions', sourcePath: 'AGENTS.md', destinations: [{ kind: 'instructions', path: 'AGENTS.md' }, { kind: 'supporting-files', path: 'repo/AGENTS.md' }], edit: { headings: [['Agent', 'Craft']] } },
  { id: 'skill', sourcePath: 'skills/write.md', destinations: [{ kind: 'native-skills', path: 'skills/write.md' }], edit: 'whole-file' },
  { id: 'soul', sourcePath: 'SOUL.md', destinations: [{ kind: 'supporting-files', path: 'SOUL.md' }], edit: 'locked' },
];
async function fixture(): Promise<{ root: string; baseline: CandidateManifest }> {
  const root = await mkdtemp(join(tmpdir(), 'paideia-candidate-')); temporary.push(root);
  await mkdir(join(root, 'skills'));
  await writeFile(join(root, 'AGENTS.md'), instructions);
  await writeFile(join(root, 'skills/write.md'), '# Writing\nUse [policy](../AGENTS.md).\n');
  await writeFile(join(root, 'SOUL.md'), 'A skeptical reporter.\n');
  return { root, baseline: await snapshotCandidate({ sourceRoot: root, resources: mapping }) };
}
function reseal(candidate: CandidateManifest): CandidateManifest {
  for (const resource of candidate.resources) resource.digest = digestBytes(resource.content);
  candidate.policyDigest = policyIdentity(candidate.resources);
  const { id: _id, baselineId, ...body } = candidate;
  candidate.id = candidateIdentity(body, candidate.parentId === null ? undefined : baselineId);
  return candidate;
}
describe('immutable multi-file candidates', () => {
  it('snapshots original bytes and only exposes explicitly editable components', async () => {
    const { baseline } = await fixture();
    expect(baseline.id).toBe(baseline.baselineId);
    expect(Object.isFrozen(baseline.resources[0]!.destinations)).toBe(true);
    expect(baseline.resources[0]!.content).toBe(instructions);
    expect(candidateComponents(baseline).map(component => component.id)).toEqual(['instructions#Agent/Craft', 'skill#file']);
    expect(candidateComponents(baseline)[0]!.text).toBe('\r\n\r\nOld prose.\r\n\r\n');
    expect(freezeCandidate(null)).toBeNull();
    expect(containedPath('/tmp/x', '/tmp/x')).toBe(true);
  });
  it('derives multiple files, verifies mirrored destinations, and leaves project source unchanged', async () => {
    const { root, baseline } = await fixture();
    const child = deriveCandidate(baseline, baseline, { 'instructions#Agent/Craft': '\r\n\r\nWrite concrete leads.\r\n\r\n', 'skill#file': '# Writing\nGround every claim.\n' });
    const next = deriveCandidate(baseline, child, { 'skill#file': '# Writing\nQuote faithfully.\n' });
    expect(next.parentId).toBe(child.id);
    expect(next.baselineId).toBe(baseline.id);
    expect(next.policyDigest).toBe(baseline.policyDigest);
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(instructions);
    const destination = join(root, 'trial');
    const receipts = await materializeCandidate(next, destination);
    expect(receipts).toHaveLength(4);
    expect(receipts.every(receipt => receipt.evidence === 'installed')).toBe(true);
    expect(await readFile(join(destination, 'AGENTS.md'), 'utf8')).toBe(await readFile(join(destination, 'repo/AGENTS.md'), 'utf8'));
    expect(await readFile(join(destination, 'skills/write.md'), 'utf8')).toContain('Quote faithfully.');
    expect(await readFile(join(destination, 'SOUL.md'), 'utf8')).toBe('A skeptical reporter.\n');
    await expect(materializeCandidate(next, destination)).rejects.toThrow(/empty trial-owned/);
  });
  it('rejects undeclared components, non-text edits, subtree escapes and policy widening', async () => {
    const { baseline } = await fixture();
    const rejected: Record<string, string>[] = [
      { 'soul#file': 'Rewrite identity' },
      { unknown: 'text' },
      { 'skill#file': 1 as unknown as string },
      { 'instructions#Agent/Craft': '\n## Policy\nOverride.\n' },
      { 'instructions#Agent/Craft': '\n```\nSwallow locked text' },
    ];
    for (const replacements of rejected) expect(() => deriveCandidate(baseline, baseline, replacements)).toThrow();
    const changed = structuredClone(baseline);
    changed.parentId = baseline.id;
    changed.resources[0]!.edit = 'whole-file';
    reseal(changed);
    expect(() => deriveCandidate(baseline, changed, {})).toThrow(/baseline|policy/);
    expect(() => deriveCandidate(deriveCandidate(baseline, baseline, {}), baseline, {})).toThrow(/original baseline/);
  });
  it('checks locked bytes even when someone recomputes an edited manifest checksum', async () => {
    const { root, baseline } = await fixture();
    for (const index of [0, 2]) {
      const forged = structuredClone(baseline);
      forged.parentId = baseline.id;
      forged.resources[index]!.content = forged.resources[index]!.content.replace(index === 0 ? 'Never browse.' : 'skeptical', 'CHANGED');
      reseal(forged);
      expect(() => validateCandidate(forged)).toThrow(/Locked/);
      await expect(materializeCandidate(forged, join(root, `forged-${index}`))).rejects.toThrow(/Locked/);
    }
    const forgedSource = structuredClone(baseline);
    forgedSource.parentId = baseline.id;
    forgedSource.resources[2]!.sourceContent = forgedSource.resources[2]!.content = 'Forged original';
    forgedSource.resources[2]!.sourceDigest = digestBytes('Forged original');
    expect(() => validateCandidate(reseal(forgedSource))).toThrow(/baseline/);
  });
  it('rejects malformed manifest identities and resource digests', async () => {
    const { baseline } = await fixture();
    for (const mutate of [
      (value: CandidateManifest) => { value.schema = 'other' as CandidateManifest['schema']; },
      (value: CandidateManifest) => { value.id = 'changed'; },
      (value: CandidateManifest) => { value.policyDigest = 'changed'; },
      (value: CandidateManifest) => { value.resources[0]!.digest = 'changed'; },
      (value: CandidateManifest) => { value.resources[0]!.sourceDigest = 'changed'; },
      (value: CandidateManifest) => { value.resources[0]!.content = '\0'; },
      (value: CandidateManifest) => { value.resources[0]!.content = 'x'.repeat(1_048_577); },
    ]) { const changed = structuredClone(baseline); mutate(changed); expect(() => validateCandidate(changed)).toThrow(); }
  });
  it('authenticates contained source aliases and rejects escapes or duplicate policies', async () => {
    const { root } = await fixture();
    await symlink('AGENTS.md', join(root, 'alias.md'));
    const alias = { ...mapping[0]!, sourcePath: 'alias.md' };
    expect((await snapshotCandidate({ sourceRoot: root, resources: [alias] })).resources[0]!.content).toBe(instructions);
    await expect(snapshotCandidate({ sourceRoot: root, resources: [alias, { ...mapping[1]!, sourcePath: 'AGENTS.md' }] })).rejects.toThrow(/Aliased/);
    await symlink('/etc/hosts', join(root, 'outside.md'));
    await expect(snapshotCandidate({ sourceRoot: root, resources: [{ ...alias, sourcePath: 'outside.md' }] })).rejects.toThrow(/escapes/);
    await expect(snapshotCandidate({ sourceRoot: root, resources: [{ ...alias, sourcePath: 'skills' }] })).rejects.toThrow(/regular file/);
    await writeFile(join(root, 'binary.md'), Buffer.from([0xff]));
    await expect(snapshotCandidate({ sourceRoot: root, resources: [{ ...alias, sourcePath: 'binary.md' }] })).rejects.toThrow(/UTF-8/);
    await writeFile(join(root, 'huge.md'), 'x'.repeat(1_048_577));
    await expect(snapshotCandidate({ sourceRoot: root, resources: [{ ...alias, sourcePath: 'huge.md' }] })).rejects.toThrow(/1 MiB/);
    await symlink('skills', join(root, 'destination'));
    await expect(materializeCandidate(await snapshotCandidate({ sourceRoot: root, resources: [alias] }), join(root, 'destination'))).rejects.toThrow(/plain directory/);
  });
  it.each(['/secret', '../secret', 'a/../b', 'a\\b', 'C:/secret', 'a//b', './a', 'a\0b', ''])('rejects unsafe native/source path %s', value => expect(() => relativeResourcePath(value)).toThrow(/Unsafe/));
});

it('rejects ill-formed replacement text instead of installing different UTF-8 bytes', async () => {
  const { baseline } = await fixture();
  expect(() => deriveCandidate(baseline, baseline, { 'skill#file': '\ud800' })).toThrow(/UTF-8/);
});
