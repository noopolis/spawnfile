import { readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { stringify } from 'yaml';
import { stableDigest } from '../../../graders/index.js';
import { runDecompose, selectTeachers } from './decompose.js';
import { readTemplates, readInputs, readDecompositions, readOptional, workers } from './files.js';
import { fixture } from './fixtures.js';

it('extracts, audits, pins bytes, stores receipt accounting and resumes without calls', async () => {
  const f = await fixture();
  expect(await runDecompose(f.decompose, f.dependencies)).toMatchObject({ completed: 1, resumed: 0, rejected: 0 });
  expect(f.generate).toHaveBeenCalledTimes(2);
  const files = await readdir(f.decompose.out);
  const docFile = join(f.decompose.out, files.find(file => file.endsWith('.decomposition.json'))!);
  const doc = JSON.parse(await readFile(docFile, 'utf8'));
  expect(doc).toMatchObject({ units: [f.unit], audit: { missed: [], extractor: { provider: 'claude' } } });
  const checkpoint = JSON.parse(await readFile(join(f.decompose.out, files.find(file => file.endsWith('.checkpoint.json'))!), 'utf8'));
  expect(checkpoint.receipts).toHaveLength(2);
  expect(checkpoint.receipts[0]).toMatchObject({ reported_model: 'test-codex', usage: null, wall_ms: expect.any(Number) });
  await rm(docFile);
  expect(await runDecompose(f.decompose, f.dependencies)).toMatchObject({ completed: 1, resumed: 1 });
  expect(f.generate).toHaveBeenCalledTimes(2);
  expect(JSON.parse(await readFile(docFile, 'utf8'))).toEqual(doc);
  await writeFile(join(f.root, 'output.json'), JSON.stringify({ body: ['Alice reported 13 items.'] }));
  await expect(runDecompose(f.decompose, f.dependencies)).rejects.toThrow('Invalid decomposition checkpoint');
});

it('sends kind descriptions and persists citation disagreements and location exclusions', async () => {
  const f = await fixture();
  await writeFile(f.templatesFile, stringify({ ...f.templates, kinds: { claim: 'Verbatim factual claim', display: 'Headline or deck' },
    templates: [{ ...f.templates.templates[0], locations: ['headline'] }] }));
  f.generate.mockResolvedValueOnce({ text: JSON.stringify({ units: [{ ...f.unit, paragraph: 7, sentence: 3, cites: ['B2'] }] }),
    model: 'test', usage: null, route: 'subscription' });
  expect(await runDecompose(f.decompose, f.dependencies)).toMatchObject({ rejected: 0 });
  for (const [request] of f.generate.mock.calls) {
    expect(JSON.parse(request.prompt).requirements).toContain("source_span (optional) = a verbatim quote from ONE of the unit's cited evidence rows that supports the unit; omit it if none.");
    expect(JSON.parse(request.prompt)).toMatchObject({ kinds: ['claim', 'display'],
      kind_descriptions: { claim: 'Verbatim factual claim', display: 'Headline or deck' } });
  }
  const files = await readdir(f.decompose.out);
  const load = async (suffix: string) => JSON.parse(await readFile(join(f.decompose.out, files.find(file => file.endsWith(suffix))!), 'utf8'));
  expect(await load('.checkpoint.json')).toMatchObject({ citationDisagreements: [{ id: 'claim', supplied: ['B2'], derived: ['A1'] }] });
  expect(await load('.instantiation.json')).toEqual({ checks: [], skipped: [{ template_id: 'support', unit_id: 'claim',
    location: 'body', reason: 'outside declared template locations' }] });
  expect(await runDecompose(f.decompose, f.dependencies)).toMatchObject({ resumed: 1 });
  expect(f.generate).toHaveBeenCalledTimes(2);
});

it('resumes extraction after an audit failure and retains rejected invented units', async () => {
  const f = await fixture();
  f.generate.mockResolvedValueOnce({ text: JSON.stringify({ units: [f.unit, { ...f.unit, id: 'invented', text: 'Invented detail.' }] }),
    model: 'unknown', modelBasis: 'requested-assumption', route: 'subscription', usage: null }).mockRejectedValueOnce(new Error('offline'));
  await expect(runDecompose(f.decompose, f.dependencies)).rejects.toThrow('offline');
  expect(await runDecompose({ ...f.decompose, extractors: ['codex', 'claude'] }, f.dependencies)).toMatchObject({ completed: 1, rejected: 1 });
  expect(f.generate).toHaveBeenCalledTimes(3);
  const loaded = await readDecompositions(f.decompose.out, await readTemplates(f.templatesFile));
  expect(loaded[0]!.doc.units).toEqual([{ ...f.unit, location: 'body' }]);
});

it('refuses bad teacher selections, uncontained providers, malformed and duplicate-key extraction responses', async () => {
  const f = await fixture(); const templates = await readTemplates(f.templatesFile);
  for (const ids of [[], ['codex', 'codex'], ['unknown']]) expect(() => selectTeachers(templates, ids)).toThrow();
  expect(() => selectTeachers({ ...templates, teachers: undefined }, ['codex'])).toThrow('Unknown teacher');
  await expect(runDecompose({ ...f.decompose, extractors: ['grok'] }, f.dependencies)).rejects.toThrow('Codex/Claude');
  f.provider.capabilities.billing = 'api';
  await expect(runDecompose(f.decompose, f.dependencies)).rejects.toThrow('subscription');
  f.provider.capabilities.billing = 'subscription';
  for (const [index, text] of ['{}', '{"units":[],"extra":1}', '{"units":[],"units":[]}', 'null', '[]', '{"units":null}', 'units: []'].entries()) {
    f.generate.mockResolvedValueOnce({ text, model: 'fake', usage: null, route: 'subscription' });
    await expect(runDecompose({ ...f.decompose, out: join(f.root, `invalid-${index}`) }, f.dependencies)).rejects.toThrow();
  }
  await expect(runDecompose({ ...f.decompose, signal: AbortSignal.abort() }, f.dependencies)).rejects.toThrow();
});

it('rejects changed policy, corrupted checkpoints and invalid checksummed stored spans', async () => {
  const f = await fixture(); await runDecompose({ ...f.decompose, extractors: ['codex'] }, f.dependencies);
  await expect(runDecompose(f.decompose, f.dependencies)).rejects.toThrow('Stale decomposition checkpoint');
  const file = join(f.decompose.out, (await readdir(f.decompose.out)).find(file => file.endsWith('.checkpoint.json'))!);
  const checkpoint = JSON.parse(await readFile(file, 'utf8'));
  checkpoint.decomposition.units[0].text = 'Tampered';
  await writeFile(file, JSON.stringify(checkpoint));
  await expect(runDecompose({ ...f.decompose, extractors: ['codex'] }, f.dependencies)).rejects.toThrow('Corrupt');
  const { digest: _digest, ...content } = checkpoint;
  checkpoint.digest = stableDigest(content);
  await writeFile(file, JSON.stringify(checkpoint));
  await expect(runDecompose({ ...f.decompose, extractors: ['codex'] }, f.dependencies)).rejects.toThrow('Invalid decomposition checkpoint');
});

it('validates manifest identities, declared contexts, file hashes and source JSON', async () => {
  const f = await fixture(); const templates = await readTemplates(f.templatesFile);
  const writeManifest = (items: unknown[]) => writeFile(f.inputsFile, stringify(JSON.parse(JSON.stringify({ schema: 'paideia.grader-inputs.v1', items }))));
  await writeManifest([f.items[0], f.items[0]]);
  await expect(readInputs(f.inputsFile, templates)).rejects.toThrow('Duplicate');
  await writeManifest([{ ...f.items[0], context: { unknown: { from: 'evidence.md' } } }]);
  await expect(readInputs(f.inputsFile, templates)).rejects.toThrow('Undeclared');
  await writeManifest(f.items);
  await runDecompose(f.decompose, f.dependencies);
  await writeFile(join(f.root, 'evidence.md'), 'changed');
  await expect(readDecompositions(f.decompose.out, templates)).rejects.toThrow('Content digest mismatch');
  await writeFile(join(f.root, 'output.json'), '{bad json');
  await expect(readInputs(f.inputsFile, templates)).rejects.toThrow();
  await expect(readDecompositions(f.root, templates)).rejects.toThrow('No decomposition');
  expect(await readOptional(join(f.root, 'missing'))).toBeUndefined();
  await expect(readOptional(join(f.root, 'output.json'))).rejects.toThrow();
});

it('bounds workers, drains started jobs after failure and propagates cancellation', async () => {
  for (const concurrency of [0, 65, 1.5]) await expect(workers([], concurrency, async () => undefined)).rejects.toThrow('concurrency');
  const completed: number[] = [];
  await workers([1, 2, 3], 2, async item => { completed.push(item); });
  expect(completed).toHaveLength(3);
  await expect(workers([1], 1, async () => undefined, AbortSignal.abort())).rejects.toThrow();
  let drained = false;
  await expect(workers([1, 2, 3], 2, async item => {
    if (item === 1) throw new Error('fail');
    await Promise.resolve(); drained = true;
  })).rejects.toThrow('fail');
  expect(drained).toBe(true);
});
