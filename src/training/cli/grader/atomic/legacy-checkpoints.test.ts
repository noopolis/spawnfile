import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { stableDigest } from '../../../graders/index.js';
import { runDecompose } from './decompose.js';
import { runTraps } from './traps.js';
import { runReference } from './reference.js';
import { readInputs, readTemplates, readDecompositions } from './files.js';
import { fixture } from './fixtures.js';

// Independent pre-rename formulas copied from origin/main (624a972).
// Do not import the frozen domains: these fixtures must catch a domain mutation.
it('resumes a pre-rename in-flight extraction checkpoint without repeating paid extraction', async () => {
  const f = await fixture();
  f.generate.mockRejectedValueOnce(new Error('interrupted'));
  await expect(runDecompose(f.decompose, f.dependencies)).rejects.toThrow('interrupted');
  const templates = await readTemplates(f.templatesFile);
  const [input] = await readInputs(f.inputsFile, templates);
  const file = join(f.decompose.out, (await readdir(f.decompose.out)).find(name => name.endsWith('.checkpoint.json'))!);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  saved.identity = stableDigest({ refs: input!.refs, templates: {
    obligation_kinds: ['obligation'], kinds: {},
    templates: templates.templates.map(t => ({ applies_to: t.applies_to, locations: t.locations })),
    context: Object.fromEntries(Object.entries(templates.context).map(([name, value]) => [name, { rows: value.rows, role: value.role }])),
  }, teachers: templates.teachers!.slice(0, 2), protocol: 'paideia.extraction.v9' });
  // A received response was checkpointed before the old process stopped decoding.
  saved.receipts = [{ teacher: 'codex', phase: 'extract', response_text: JSON.stringify({ units: [f.unit] }),
    outcome: 'received', provider: 'codex', model: 'test-codex', prompt_digest: 'a'.repeat(64),
    at: '2026-10-11T12:00:00Z', reported_model: 'test-codex', usage: null, wall_ms: 1, route: 'subscription' }];
  const { digest: _digest, ...content } = saved;
  saved.digest = stableDigest(content);
  await writeFile(file, JSON.stringify(saved));
  f.generate.mockClear();
  f.generate.mockResolvedValue({ text: '{"units":[]}', model: 'test-claude', usage: null, route: 'subscription' });
  expect(await runDecompose(f.decompose, f.dependencies)).toMatchObject({ completed: 1 });
  expect(f.generate).toHaveBeenCalledTimes(1); // audit only
  const completed = JSON.parse(await readFile(file, 'utf8'));
  completed.decomposition.schema = 'paideia.decomposition.v1';
  const { digest: _completedDigest, ...completedContent } = completed;
  completed.digest = stableDigest(completedContent);
  await writeFile(file, JSON.stringify(completed));
  expect(await runDecompose(f.decompose, f.dependencies)).toMatchObject({ resumed: 1 });
  const docFile = join(f.decompose.out, (await readdir(f.decompose.out)).find(name => name.endsWith('.decomposition.json'))!);
  expect(JSON.parse(await readFile(docFile, 'utf8')).schema).toBe('spawnfile.training.decomposition.v1');
  expect(f.generate).toHaveBeenCalledTimes(1);
});

it('retains pre-rename decomposition, base-reference and trap identities', async () => {
  const f = await fixture();
  await runDecompose(f.decompose, f.dependencies);
  const templates = await readTemplates(f.templatesFile);
  const [input] = await readDecompositions(f.decompose.out, templates);
  const oldDoc = { ...input!.doc, schema: 'paideia.decomposition.v1' };
  const oldTemplates = { ...templates, schema: 'paideia.check-templates.v1' };
  const oldDigest = stableDigest({ doc: oldDoc, templates: oldTemplates });
  expect(input!.digest).toBe(oldDigest);
  await writeFile(join(f.decompose.out, input!.file), JSON.stringify(oldDoc));
  await writeFile(f.templatesFile, JSON.stringify(oldTemplates));
  const base = join(f.root, 'base.json');
  const reference = { schema: 'paideia.references.v1', templatesDigest: stableDigest(oldTemplates), outputs: {
    [input!.file]: { complete: true, outputDigest: oldDigest, checks: { 'support@x1': { final: 'supported' } } },
  } };
  await writeFile(base, JSON.stringify({ ...reference, digest: stableDigest(reference) }));
  const generated = await runTraps({ ...f.traps, references: base });
  expect(generated.generated).toBeGreaterThan(0);
  const file = join(f.traps.out, (await readdir(f.traps.out))[0]!);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  const oldIdentity = stableDigest({ baseFinals: { 'support@x1': 'supported' }, input: oldDigest, seed: '0', protocol: 'paideia.traps.v1' });
  expect(saved.identity).toBe(oldIdentity);
  await writeFile(file, JSON.stringify({ ...saved, schema: 'paideia.traps.v1', identity: oldIdentity }));
  await expect(runTraps({ ...f.traps, references: base })).resolves.toEqual(generated);
  await expect(runTraps({ ...f.traps, references: base, seed: 'changed' })).rejects.toThrow('Stale trap');
  f.generate.mockImplementation(async request => ({ text: JSON.stringify(Object.fromEntries(
    JSON.parse(request.prompt).questions.map((question: { key: string }) => [question.key, { answer: 'supported' }]))),
    model: request.model, route: 'subscription', usage: null }));
  await runReference({ ...f.reference, traps: undefined }, f.dependencies);
  const artifact = JSON.parse(await readFile(f.reference.out, 'utf8'));
  expect(artifact.templatesDigest).toBe(stableDigest(oldTemplates));
});
