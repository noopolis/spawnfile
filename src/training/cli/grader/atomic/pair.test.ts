import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { stringify } from 'yaml';
import { stableDigest } from '../../../graders/index.js';
import { runDecompose, selectTeachers } from './decompose.js';
import { readInputs, readTemplates } from './files.js';
import { fixture } from './fixtures.js';

async function setup() {
  const f = await fixture();
  f.templates.templates[0]!.state.push('unit.pair', 'unit.pair.cited_rows');
  await writeFile(f.templatesFile, stringify(f.templates));
  await writeFile(join(f.root, 'output.json'), JSON.stringify({
    body: ['Alice reported 12 items. [A1]', 'Bob reported 5 items. [B2]', 'Carol reported 3 items. [C3]'],
  }));
  await writeFile(join(f.root, 'evidence.md'), '## A1\nAlice reported 12 items.\n## B2\nBob reported 5 items.\n## C3\nCarol reported 3 items.');
  const pair = { ...f.unit, pair: { left: { text: f.unit.text }, right: { text: 'Bob reported 5 items.' } } };
  const response = (units: unknown[]) => ({ text: JSON.stringify({ units }), model: 'test', route: 'subscription' as const, usage: null });
  const load = async (suffix: string) => {
    const file = join(f.decompose.out, (await readdir(f.decompose.out)).find(name => name.endsWith(suffix))!);
    return { file, value: JSON.parse(await readFile(file, 'utf8')) };
  };
  return { ...f, pair, response, load };
}

it('extracts output pairs, retains distinct same-anchor relations and reversed order, and deduplicates only exact pairs', async () => {
  const f = await setup();
  const other = { ...f.pair, pair: { ...f.pair.pair, right: { text: 'Carol reported 3 items.' } } };
  const reversed = { ...f.pair, pair: { left: f.pair.pair.right, right: f.pair.pair.left } };
  f.generate.mockResolvedValueOnce(f.response([f.pair])).mockResolvedValueOnce(f.response([
    { ...f.pair, pair: { left: { text: ' Alice\nreported 12 items. ' }, right: { text: ' Bob\treported 5 items. ', paragraph: 99 } } },
    other, reversed, other, f.unit,
  ]));
  expect(await runDecompose(f.decompose, f.dependencies)).toMatchObject({ rejected: 0, duplicates: 2 });
  const doc = (await f.load('.decomposition.json')).value;
  expect(doc.units[0].pair).toMatchObject({
    left: { paragraph: 0, cites: ['A1'] }, right: { paragraph: 1, cites: ['B2'] },
  });
  expect(doc.audit.missed.map((unit: { id: string }) => unit.id)).toEqual(['a2', 'a3', 'a5']);
  expect((await f.load('.checkpoint.json')).value.duplicates.map((unit: { id: string }) => unit.id)).toEqual(['a1', 'a4']);
  const report = (await f.load('.instantiation.json')).value;
  expect(report.checks.map((check: { status: string }) => check.status)).toEqual(['ready', 'ready', 'ready', 'missing']);
  expect(report.checks[1].projection['unit.pair.cited_rows'].right).toEqual([{ id: 'C3', text: '## C3\nCarol reported 3 items.', context: 'evidence' }]);
  expect(await runDecompose(f.decompose, f.dependencies)).toMatchObject({ resumed: 1, duplicates: 2 });
  expect(f.generate).toHaveBeenCalledTimes(2);
  for (const [request] of f.generate.mock.calls) {
    const prompt = JSON.parse(request.prompt);
    expect(prompt.templates[0]).toMatchObject({ pair: true });
    expect(prompt.pair_requirements).toContain('Both endpoints must independently occur in OUTPUT');
    expect(request.responseSchema).toHaveProperty('properties.units.items.properties.pair.properties.left.properties.text');
  }
});

it('keeps unresolved or forged audit pairs as rejections rather than discarding their valid repeated anchor', async () => {
  const f = await setup();
  await writeFile(join(f.root, 'output.json'), JSON.stringify({
    body: ['Alice reported 12 items. [A1]', 'Bob reported 5 items. [B2]', 'Bob reported 5 items. [C3]'],
  }));
  f.pair.pair.right = { ...f.pair.pair.right, paragraph: 1 } as typeof f.pair.pair.right;
  f.generate.mockResolvedValueOnce(f.response([f.pair])).mockResolvedValueOnce(f.response([
    { ...f.pair, pair: { ...f.pair.pair, right: { text: 'Bob reported 5 items.' } } },
    { ...f.pair, pair: { ...f.pair.pair, right: { text: 'Not in the output.' } } },
    { ...f.pair, pair: { ...f.pair.pair, right: { text: 'Bob reported 5 items.', paragraph: 2 } } },
  ]));
  expect(await runDecompose(f.decompose, f.dependencies)).toMatchObject({ rejected: 2, duplicates: 0 });
  const doc = (await f.load('.decomposition.json')).value;
  expect(doc.rejected.map((item: { id: string }) => item.id)).toEqual(['a1', 'a2']);
  expect(doc.audit.missed).toMatchObject([{ id: 'a3', pair: { right: { paragraph: 2, cites: ['C3'] } } }]);
  expect(await runDecompose(f.decompose, f.dependencies)).toMatchObject({ resumed: 1, rejected: 2 });
  expect(f.generate).toHaveBeenCalledTimes(2);
});

it('revalidates pair endpoints before resuming a checksummed checkpoint', async () => {
  const f = await setup();
  f.generate.mockResolvedValueOnce(f.response([f.pair]));
  await runDecompose(f.decompose, f.dependencies);
  const { file, value } = await f.load('.checkpoint.json');
  value.decomposition.units[0].pair.right.text = 'Forged checkpoint endpoint';
  const { digest: _digest, ...content } = value;
  await writeFile(file, JSON.stringify({ ...content, digest: stableDigest(content) }));
  await expect(runDecompose(f.decompose, f.dependencies)).rejects.toThrow('Invalid decomposition checkpoint');
  expect(f.generate).toHaveBeenCalledTimes(2);
});

it('pins pair extraction declarations while permitting grading-only edits between pair reads', async () => {
  const f = await setup();
  f.generate.mockResolvedValueOnce(f.response([f.pair]));
  await runDecompose(f.decompose, f.dependencies);
  const templates = await readTemplates(f.templatesFile);
  templates.templates[0]!.state = ['unit.pair'];
  await writeFile(f.templatesFile, stringify(templates));
  expect(await runDecompose(f.decompose, f.dependencies)).toMatchObject({ resumed: 1 });
  templates.templates[0]!.state = ['unit'];
  await writeFile(f.templatesFile, stringify(templates));
  await expect(runDecompose(f.decompose, f.dependencies)).rejects.toThrow('Stale decomposition checkpoint');
  expect(f.generate).toHaveBeenCalledTimes(2);
});

it('rejects actual v8 allowlisted checkpoints before making new calls', async () => {
  const f = await fixture();
  await runDecompose(f.decompose, f.dependencies);
  const templates = await readTemplates(f.templatesFile), [input] = await readInputs(f.inputsFile, templates);
  const file = join(f.decompose.out, (await readdir(f.decompose.out)).find(name => name.endsWith('.checkpoint.json'))!);
  const { digest: _digest, ...content } = JSON.parse(await readFile(file, 'utf8'));
  const extraction = { kinds: templates.kinds ?? {}, templates: templates.templates.map(template => ({
    applies_to: template.applies_to, locations: template.locations,
    when: template.when ? { field: template.when.field } : undefined,
  })), context: Object.fromEntries(Object.entries(templates.context).map(([name, declaration]) =>
    [name, { rows: declaration.rows, role: declaration.role }])) };
  content.identity = stableDigest({ refs: input!.refs, templates: extraction,
    teachers: selectTeachers(templates, f.decompose.extractors), protocol: 'paideia.extraction.v8' });
  await writeFile(file, JSON.stringify({ ...content, digest: stableDigest(content) }));
  await expect(runDecompose(f.decompose, f.dependencies)).rejects.toThrow('Stale decomposition checkpoint');
  expect(f.generate).toHaveBeenCalledTimes(2);
});


it('declares pair extraction requirements for a pair source read without a separate pair projection', async () => {
  const f = await setup();
  Object.assign(f.templates.context, { source_snapshots: { description: 'Caller-validated sources' } });
  f.templates.templates[0]!.state = ['unit', 'unit.pair.source_snapshots'];
  await writeFile(f.templatesFile, stringify(f.templates));
  f.generate.mockResolvedValueOnce(f.response([f.pair])).mockResolvedValueOnce(f.response([]));
  await runDecompose(f.decompose, f.dependencies);
  for (const [request] of f.generate.mock.calls) {
    const prompt = JSON.parse(request.prompt);
    expect(prompt.templates[0]).toMatchObject({ pair: true });
    expect(prompt.pair_requirements).toContain('Both endpoints must independently occur in OUTPUT');
  }
});
