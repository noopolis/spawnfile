import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { candidateComponents, deriveCandidate, snapshotCandidate, validateCandidate } from './index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function baseline(content: string) {
  const root = await mkdtemp(join(tmpdir(), 'paideia-section-boundary-')); roots.push(root);
  await writeFile(join(root, 'AGENTS.md'), content);
  return snapshotCandidate({ sourceRoot: root, resources: [{ id: 'instructions', sourcePath: 'AGENTS.md',
    destinations: [{ kind: 'instructions', path: 'AGENTS.md' }], edit: { headings: [['Foreman', 'Prose and beat']] } }] });
}

it.each(['\n', '\r\n', '\r'])('delimits unpadded replacement prose with the original %j separator', async newline => {
  const before = ['# Foreman', '## Prose and beat', '', 'Original prose.', '', '## Policy', 'Locked.'].join(newline);
  const original = await baseline(before);
  const child = deriveCandidate(original, original, { 'instructions#Foreman/Prose%20and%20beat': 'Lead with the actor.' });
  expect(child.resources[0]!.content).toBe(['# Foreman', '## Prose and beat', 'Lead with the actor.', '## Policy', 'Locked.'].join(newline));
  expect(() => validateCandidate(child)).not.toThrow();
  expect(candidateComponents(child)[0]!.text).toBe(`${newline}Lead with the actor.${newline}`);
});

it.each(['New prose.', 'New prose.\r\n', '', '\n'])('keeps a following setext heading separate for %j', async replacement => {
  const original = await baseline('# Foreman\r\n## Prose and beat\r\nOriginal.\r\n\r\nPolicy\r\n------\r\nLocked.');
  const child = deriveCandidate(original, original, { 'instructions#Foreman/Prose%20and%20beat': replacement });
  expect(child.resources[0]!.content).toContain('Policy\r\n------\r\nLocked.');
  expect(() => validateCandidate(child)).not.toThrow();
  expect(candidateComponents(child)[0]!.text.replace(/\r\n|\r/gu, '\n')).toMatch(/\n\n$/u);
});

it('preserves supplied separator bytes', async () => {
  const original = await baseline('# Foreman\n## Prose and beat\n\nOriginal.\n\n## Policy\nLocked.');
  const component = candidateComponents(original)[0]!;
  const child = deriveCandidate(original, original, { [component.id]: component.text });
  expect(child.resources[0]!.content).toBe(original.resources[0]!.content);
});

it.each(['\r\n', '\r'])('inherits %j from the preceding source when the EOF body is empty', async newline => {
  const original = await baseline(`# Foreman${newline}## Prose and beat`);
  const child = deriveCandidate(original, original, { 'instructions#Foreman/Prose%20and%20beat': 'New prose.' });
  expect(child.resources[0]!.content).toBe(`# Foreman${newline}## Prose and beat${newline}New prose.`);
});

it.each(['', 'New prose.', '\nNew prose.\n'])('supports end-of-file section replacement %j', async replacement => {
  const original = await baseline('# Foreman\n## Prose and beat');
  const child = deriveCandidate(original, original, { 'instructions#Foreman/Prose%20and%20beat': replacement });
  expect(child.resources[0]!.content).toBe('# Foreman\n## Prose and beat' + (replacement && !replacement.startsWith('\n') ? '\n' : '') + replacement);
});

it('still rejects replacement headings or fences that change locked structure', async () => {
  const original = await baseline('# Foreman\n## Prose and beat\nOriginal.\n## Policy\nLocked.');
  for (const replacement of ['## Policy\nOverride.', '```\nSwallow policy.']) {
    expect(() => deriveCandidate(original, original, { 'instructions#Foreman/Prose%20and%20beat': replacement })).toThrow();
  }
});
