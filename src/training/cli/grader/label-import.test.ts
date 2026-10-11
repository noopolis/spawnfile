import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parse, stringify } from 'yaml';
import { afterEach, expect, it, vi } from 'vitest';
import { loadGrader, loadLabels, deriveConsensus, sha256, stableDigest, type Labels } from '../../graders/index.js';
import { validateStoredVotes, voteProvenance, groupLabelInstances } from '../../graders/labeling/index.js';
import { main } from '../commands.js';
import { parseArguments } from '../arguments.js';
import { runLabel } from './label.js';
import { runLabelImport } from './label-import.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'label-import-')); directories.push(dir);
  await fs.mkdir(path.join(dir, 'data')); await fs.mkdir(path.join(dir, 'golden'));
  const graderFile = path.join(dir, 'grader.yaml'), importFile = path.join(dir, 'data', 'import.yaml');
  const labelsFile = path.join(dir, 'golden', 'labels.yaml');
  const grader = { schema: 'paideia.grader.v1', id: 'writing', golden: 'golden/labels.yaml', calibration: 'c.json',
    context: { evidence: { description: 'Sources' } }, teachers: [{ id: 't', provider: 'grok', model: 'm' }],
    model: { backend: 'teacher', teacher: 't' }, escalate: { to: 't', between: [0.2, 0.8] },
    questions: [
      { id: 'q', type: 'yes-no', expected: 'yes', reads: ['output.body', 'context.evidence'] },
      { id: 'p', type: 'choice', options: ['good', 'bad'], expected: ['good'], level: 'paragraph', reads: ['paragraph'] },
      { id: 'conditional', type: 'yes-no', expected: 'yes', reads: ['output.body'], when: { field: 'output.kind', equals: 'report' } },
      { id: 'missing', type: 'yes-no', expected: 'yes', reads: ['output.absent'] },
    ], score: { method: 'weighted' } };
  const item = { id: 'a', lineage: 'story', example: { dataset: 'test', id: 'x' },
    output: { from: 'out.json' }, context: { evidence: { from: 'evidence.md' } }, labeler: 'editor',
    votes: { q: 'no', 'p@p0': 'good' } as Record<string, string | number>, note: 'Mapped verdict' };
  const manifest = { schema: 'paideia.label-import.v1', grader: 'writing',
    labelers: { editor: { kind: 'editor', name: 'Editor', source: 'Verdicts' }, reviewer: { kind: 'human', name: 'Reviewer' } }, items: [item] };
  await Promise.all([fs.writeFile(graderFile, stringify(grader)), fs.writeFile(importFile, stringify(manifest)),
    fs.writeFile(path.join(dir, 'data/out.json'), '{"body":["Hello."],"kind":"draft"}'), fs.writeFile(path.join(dir, 'data/evidence.md'), 'Evidence')]);
  const save = async () => { await fs.writeFile(importFile, stringify(manifest)); };
  const saved = async () => parse(await fs.readFile(labelsFile, 'utf8')) as Labels;
  return { dir, graderFile, importFile, labelsFile, grader, manifest, item, save, saved };
}

it('imports YAML with byte addresses, per-vote freshness and provenance, without model calls', async () => {
  const f = await fixture(), stdout: string[] = [], stderr: string[] = [];
  const provider = vi.fn(() => { throw new Error('No inference'); });
  expect(await main(['grader', 'label', '--grader', 'grader.yaml', '--import', 'data/import.yaml', '--timeout-ms', '10000'],
    { cwd: f.dir, stdout: text => stdout.push(text), stderr: text => stderr.push(text) }, { grader: { provider } })).toBe(0);
  expect(stderr).toEqual([]); expect(provider).not.toHaveBeenCalled();
  expect(JSON.parse(stdout.join(''))).toEqual({ labelsFile: f.labelsFile, items: 1, labelsAdded: 1, labelsMerged: 0,
    votesByLabeler: { editor: 2 }, votesByQuestion: { q: 1, p: 1 } });
  const raw = await f.saved(), g = await loadGrader(f.graderFile), loaded = await loadLabels(f.labelsFile, g);
  expect(raw.labels[0]!.output).toEqual({ from: '../data/out.json', sha256: sha256(await fs.readFile(path.join(f.dir, 'data/out.json'))) });
  expect(raw.labels[0]!.context.evidence).toEqual({ from: '../data/evidence.md', sha256: sha256('Evidence') });
  const metadata = voteProvenance(raw.labels[0], 'editor', 'q')!;
  expect(metadata).toEqual({ kind: 'editor', note: 'Mapped verdict', imported_at: expect.any(String),
    import_digest: sha256(await fs.readFile(f.importFile)), question_digest: stableDigest(g.questions[0]),
    projection_digest: groupLabelInstances(g, loaded.labels.labels[0]!.output, loaded.labels.labels[0]!.context)[0]!.projectionDigest });
  expect(() => validateStoredVotes(g, loaded.labels, { resolved: true })).not.toThrow();
  g.questions[0]!.ask = 'Changed meaning';
  expect(() => validateStoredVotes(g, loaded.labels, { resolved: true })).toThrow('Stale vote a/q/editor');
  expect((await fs.readdir(path.dirname(f.labelsFile))).some(name => name.endsWith('.tmp'))).toBe(false);
});

it('merges editor then human votes into a teacher checkpoint and preserves teacher receipts', async () => {
  const f = await fixture(), inputsFile = path.join(f.dir, 'data/inputs.yaml');
  await fs.writeFile(inputsFile, stringify({ schema: 'paideia.grader-inputs.v1', items: [{
    id: f.item.id, lineage: f.item.lineage, example: f.item.example, output: f.item.output, context: f.item.context,
  }] }));
  await runLabel({ graderFile: f.graderFile, inputsFile, teachers: ['t'] }, { provider: () => ({ id: 'fake',
    capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
    generate: async request => ({ text: JSON.stringify(Object.fromEntries(JSON.parse(request.prompt).questions.map((q: { key: string }) =>
      [q.key, q.key === 'q' ? 'yes' : 'bad']))), model: 'm', usage: null, route: 'fake' }),
  }) });
  const teacher = (await f.saved()).labels[0]!.provenance.t;
  expect(await runLabelImport(f)).toMatchObject({ labelsAdded: 0, labelsMerged: 1 });
  let labels = await f.saved();
  expect(labels.labels[0]!.provenance.t).toEqual(teacher);
  expect(labels.labels[0]!.askedByInstance).toEqual({ q: ['t'], 'p@p0': ['t'] });
  expect(deriveConsensus(labels.labels[0]!, labels.labelers).q).toMatchObject({ source: 'editor', answer: 'no' });
  f.item.labeler = 'reviewer'; f.item.votes = { q: 'yes' }; await f.save();
  await runLabelImport(f); labels = await f.saved();
  expect(deriveConsensus(labels.labels[0]!, labels.labelers).q).toMatchObject({ source: 'human', answer: 'yes' });
});

it('is byte-idempotent and requires relabel for changed or stale votes', async () => {
  const f = await fixture(); await runLabelImport(f);
  const original = await fs.readFile(f.labelsFile, 'utf8');
  await runLabelImport(f); expect(await fs.readFile(f.labelsFile, 'utf8')).toBe(original);
  f.item.votes.q = 'yes'; await f.save();
  await expect(runLabelImport(f)).rejects.toThrow('a/q/editor: changed or stale vote; use --relabel');
  expect(await fs.readFile(f.labelsFile, 'utf8')).toBe(original);
  await runLabelImport({ ...f, relabel: true }); expect((await f.saved()).labels[0]!.votes.q!.editor).toBe('yes');
  f.grader.questions[0]!.expected = 'no'; await fs.writeFile(f.graderFile, stringify(f.grader));
  await expect(runLabelImport(f)).rejects.toThrow('--relabel');
  await runLabelImport({ ...f, relabel: true });
  const g = await loadGrader(f.graderFile);
  const loaded = await loadLabels(f.labelsFile, g);
  expect(() => validateStoredVotes(g, loaded.labels, { resolved: true })).not.toThrow();
});

it.each(['output', 'context'] as const)('refuses %s byte changes naming the label, even with relabel', async field => {
  const f = await fixture(); await runLabelImport(f); const original = await fs.readFile(f.labelsFile, 'utf8');
  await fs.writeFile(path.join(f.dir, field === 'output' ? 'data/out.json' : 'data/evidence.md'), field === 'output' ? '{"body":["changed"]}' : 'Changed');
  await expect(runLabelImport({ ...f, relabel: true })).rejects.toThrow('Label a: output/context sha256 mismatch');
  expect(await fs.readFile(f.labelsFile, 'utf8')).toBe(original);
});

it.each([
  ['q', 'maybe', 'invalid option'], ['p@p0', 'abstain', 'invalid option'],
  ['p@p2', 'good', 'p@p2'], ['conditional', 'yes', 'conditional'], ['missing', 'yes', 'missing'],
  ['unknown', 'yes', 'unknown'], ['p', 'good', 'instance p'], ['q@p0', 'yes', 'q@p0'],
])('refuses invalid vote %s=%s', async (key, vote, error) => {
  const f = await fixture(); f.item.votes = { [key]: vote }; await f.save();
  await expect(runLabelImport(f)).rejects.toThrow(error);
  await expect(fs.readFile(f.labelsFile)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses model-kind labelers, unknown labelers/context and mismatched graders', async () => {
  const f = await fixture();
  for (const [patch, message] of [
    [{ labelers: { editor: { kind: 'model', provider: 'grok', model: 'm' } } }, 'only human/editor'],
    [{ labelers: {} }, 'undeclared labeler editor'], [{ grader: 'wrong' }, 'does not match'],
    [{ items: [{ ...f.item, context: { unknown: { from: 'evidence.md' } } }] }, 'undeclared context unknown'],
  ] as const) {
    await fs.writeFile(f.importFile, stringify({ ...f.manifest, ...patch }));
    await expect(runLabelImport(f)).rejects.toThrow(message);
  }
});

it('refuses conflicting labeler definitions and lineage/example redefinitions', async () => {
  const f = await fixture(); await runLabelImport(f);
  f.manifest.labelers.editor.name = 'Changed'; await f.save();
  await expect(runLabelImport({ ...f, relabel: true })).rejects.toThrow('Conflicting labeler redefinition: editor');
  f.manifest.labelers.editor.name = 'Editor'; f.item.lineage = 'other'; await f.save();
  await expect(runLabelImport(f)).rejects.toThrow('lineage/example mismatch');
  f.item.lineage = 'story'; f.item.example.id = 'different'; await f.save();
  await expect(runLabelImport(f)).rejects.toThrow('lineage/example mismatch');
});

it('accepts JSON, repeated labels across reviewers, omitted context/note/example and numeric votes', async () => {
  const f = await fixture();
  const grader = { ...f.grader, questions: [{ id: 'score', type: 'score', scale: [1, 3], expected: 3, reads: ['output.body'] }] };
  await fs.writeFile(f.graderFile, stringify(grader));
  const item = { id: 'a', lineage: 'story', output: f.item.output, labeler: 'editor', votes: { score: 3 } };
  await fs.writeFile(f.importFile, JSON.stringify({ ...f.manifest, items: [item, { ...item, labeler: 'reviewer' }, { ...item, id: 'b' }] }));
  expect(await runLabelImport(f)).toMatchObject({ items: 3, labelsAdded: 2, labelsMerged: 0, votesByLabeler: { editor: 2, reviewer: 1 }, votesByQuestion: { score: 3 } });
  expect(voteProvenance((await f.saved()).labels[0], 'editor', 'score')!.note).toBeNull();
  const original = await fs.readFile(f.labelsFile, 'utf8');
  await runLabelImport(f); expect(await fs.readFile(f.labelsFile, 'utf8')).toBe(original);
});

it('compares content addresses independent of path and preserves existing example when omitted', async () => {
  const f = await fixture(); await runLabelImport(f);
  await fs.copyFile(path.join(f.dir, 'data/out.json'), path.join(f.dir, 'data/copy.json'));
  await fs.writeFile(f.importFile, stringify({ ...f.manifest, items: [{ ...f.item, example: undefined, output: { from: 'copy.json' } }] }));
  await runLabelImport(f);
  expect((await f.saved()).labels[0]!.example).toEqual(f.item.example);
});

it('refuses inline golden writes and malformed golden files', async () => {
  const f = await fixture();
  await fs.writeFile(f.labelsFile, 'bad'); await expect(runLabelImport(f)).rejects.toThrow();
  await fs.writeFile(f.graderFile, stringify({ ...f.grader, golden: { schema: 'paideia.labels.v1', labelers: {}, labels: [] } }));
  await expect(runLabelImport(f)).rejects.toThrow('inline golden labels are read-only');
});

it('keeps the checkpoint intact on later validation failure, cancellation and rename failure', async () => {
  const f = await fixture(); await runLabelImport(f); const original = await fs.readFile(f.labelsFile, 'utf8');
  f.manifest.items.push({ ...structuredClone(f.item), id: 'b', votes: { missing: 'yes' } }); await f.save();
  await expect(runLabelImport(f)).rejects.toThrow('missing');
  expect(await fs.readFile(f.labelsFile, 'utf8')).toBe(original);
  const controller = new AbortController(); controller.abort();
  await expect(runLabelImport({ ...f, signal: controller.signal })).rejects.toThrow();
  f.manifest.items.pop(); f.item.note = 'New provenance'; await f.save();
  vi.mocked(fs.rename).mockRejectedValueOnce(new Error('rename failed'));
  await expect(runLabelImport(f)).rejects.toThrow('rename failed');
  expect(await fs.readFile(f.labelsFile, 'utf8')).toBe(original);
  expect(await fs.readdir(path.dirname(f.labelsFile))).toEqual(['labels.yaml']);
});

it('accepts the import CLI mode and rejects teacher flags or silently ignored controls', () => {
  const args = ['grader', 'label', '--grader', 'g.yaml', '--import', 'i.json'];
  expect(parseArguments([...args, '--relabel']).flags.relabel).toEqual(['true']);
  for (const flag of ['inputs', 'teachers']) expect(() => parseArguments([...args, `--${flag}`, 'x'])).toThrow('mutually exclusive');
  for (const flag of ['limit', 'concurrency', 'adjudication']) expect(() => parseArguments([...args, `--${flag}`, '1'])).toThrow('does not accept');
});

it('refuses new bytes at another path for an existing label id', async () => {
  const f = await fixture(); await runLabelImport(f);
  await fs.writeFile(path.join(f.dir, 'data/changed.json'), '{"body":["Different"]}');
  f.item.output.from = 'changed.json'; await f.save();
  await expect(runLabelImport({ ...f, relabel: true })).rejects.toThrow('Label a: output/context sha256 mismatch');
});

it('merges canonically matching inline golden content and text output references', async () => {
  const f = await fixture(); await runLabelImport(f);
  const g = await loadGrader(f.graderFile);
  const loaded = await loadLabels(f.labelsFile, g);
  // Inline strings use canonical JSON identity; retain the reference for raw text context.
  const raw = await f.saved(); raw.labels[0]!.output = loaded.labels.labels[0]!.output;
  await fs.writeFile(f.labelsFile, stringify(raw));
  await runLabelImport(f);
  const grader = { ...f.grader, questions: [{ ...f.grader.questions[0]!, reads: ['context.evidence'] }, ...f.grader.questions.slice(1)] };
  await fs.writeFile(f.graderFile, stringify(grader));
  f.item.id = 'text'; f.item.output.from = 'evidence.md'; f.item.votes = { q: 'yes' }; await f.save();
  await runLabelImport(f); expect((await f.saved()).labels).toHaveLength(2);
});

it('refuses duplicate vote coordinates before writing', async () => {
  const f = await fixture(); f.manifest.items.push(structuredClone(f.item)); await f.save();
  await expect(runLabelImport(f)).rejects.toThrow('duplicate import vote q/editor');
});

it.each(['human', 'editor'])('rejects imported %s IDs reserved for teachers before writing', async kind => {
  const f = await fixture();
  await fs.writeFile(f.importFile, stringify({ ...f.manifest, labelers: { t: { kind, name: 'Impersonator' } },
    items: [{ ...f.item, labeler: 't' }] }));
  await expect(runLabelImport(f)).rejects.toThrow('t collides with configured teacher');
  await expect(fs.readFile(f.labelsFile)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['type', 'option'])('relabels answers invalidated by changed %s and validates the complete transaction', async change => {
  const f = await fixture(); await runLabelImport(f);
  const original = await fs.readFile(f.labelsFile, 'utf8');
  const key = change === 'type' ? 'q' : 'p@p0';
  const questions = f.grader.questions.map(q => q.id === key.split('@')[0]
    ? { ...q, type: 'choice', options: ['replacement', 'other'], expected: ['replacement'] } : q);
  await fs.writeFile(f.graderFile, stringify({ ...f.grader, questions }));
  f.item.votes[key] = 'replacement'; await f.save();
  await expect(runLabelImport(f)).rejects.toThrow('invalid option');
  // An unrelated replacement must not allow an invalid historical vote to survive.
  await fs.writeFile(f.importFile, stringify({ ...f.manifest, items: [{ ...f.item, votes: change === 'type' ? { 'p@p0': 'bad' } : { q: 'yes' } }] }));
  await expect(runLabelImport({ ...f, relabel: true })).rejects.toThrow('invalid option');
  expect(await fs.readFile(f.labelsFile, 'utf8')).toBe(original);
  await f.save();
  await runLabelImport({ ...f, relabel: true });
  const g = await loadGrader(f.graderFile), loaded = await loadLabels(f.labelsFile, g);
  expect(loaded.labels.labels[0]!.votes[key]!.editor).toBe('replacement');
  expect(() => validateStoredVotes(g, loaded.labels, { resolved: true })).not.toThrow();
});

it('relabel still rejects malformed stored schema and wrong grader identity', async () => {
  const f = await fixture(); await runLabelImport(f);
  const stored = await f.saved();
  for (const invalid of [{ ...stored, grader: 'wrong' }, { ...stored, labels: 'bad' }]) {
    const bytes = stringify(invalid); await fs.writeFile(f.labelsFile, bytes);
    await expect(runLabelImport({ ...f, relabel: true })).rejects.toThrow();
    expect(await fs.readFile(f.labelsFile, 'utf8')).toBe(bytes);
  }
});
