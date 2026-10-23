import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { fixture } from './fixture.js';
import { capturedTrial } from './source.js';
import { createHash } from 'node:crypto';
import { parseDatasetYaml, resolveDataset, projectDatasetCost, type CostDataset } from '../../cases/index.js';
import { planTrainingCost } from '../costs/index.js';
import { runStoredTrial, type StoredTrialOptions } from '../trials/index.js';
import { validateCandidate, deriveAuthoredCandidate, type CandidateManifest } from '../../candidates/index.js';

const digestBytes = (bytes: string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const identity = (value: unknown) => digestBytes(JSON.stringify(value, (_key, child: unknown) =>
  child && typeof child === 'object' && !Array.isArray(child)
    ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : child));
const dataset = (value: unknown) => parseDatasetYaml(JSON.stringify(value)).dataset;

it('reads a real legacy stored capture while verifying its unchanged manifest and report digests', async () => {
  const f = await fixture();
  const manifestPath = join(f.runRoot, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.manifest.schema = 'paideia.run.v1';
  manifest.digest = identity(manifest.manifest);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const stored = JSON.parse(await readFile(f.originalPath, 'utf8'));
  stored.report.schema = 'paideia.trial.v1';
  const { digest: _old, ...body } = stored;
  stored.digest = identity(body);
  await writeFile(f.originalPath, JSON.stringify(stored));
  const replay = await f.store.readReplay('trial', f.options.access);
  expect(replay.manifest.schema).toBe('paideia.run.v1');
  const captured = capturedTrial(replay);
  expect(captured.report.schema).toBe('spawnfile.training.trial.v1');
  expect(captured.source.digest).toBe(stored.digest);
  expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toEqual(manifest);
  stored.report.snapshot.output = 'tampered';
  await writeFile(f.originalPath, JSON.stringify(stored));
  await expect(f.store.readReplay('trial', f.options.access)).rejects.toThrow('integrity mismatch');
});
it('accepts only supported legacy dataset versions and emits the canonical dataset schema', () => {
  expect(dataset({ schema: 'paideia.dataset.v1', id: 'd', records: [{ id: 'r', input: { prompt: 'p' } }] }).schema)
    .toBe('spawnfile.training.dataset.v1');
  expect(() => dataset({ schema: 'paideia.dataset.v2', id: 'd', records: [] })).toThrow('$.schema');
});
it('verifies historical candidate identities and derives only current-wire candidates', () => {
  const content = 'Original';
  const resources = [{ id: 'instructions', sourcePath: 'AGENTS.md', destinations: [{ kind: 'instructions' as const, path: 'AGENTS.md' }],
    edit: 'whole-file' as const, content, sourceContent: content, digest: digestBytes(content), sourceDigest: digestBytes(content) }];
  const body = { schema: 'paideia.candidate.v1', parentId: null, policyDigest: identity(resources.map(({ content: _c, digest: _d, ...policy }) => policy)), resources };
  const id = identity(body);
  const candidate = { ...body, id, baselineId: id } as CandidateManifest;
  expect(() => validateCandidate(candidate)).not.toThrow();
  expect(candidate.schema).toBe('paideia.candidate.v1');
  const derived = deriveAuthoredCandidate(candidate, { 'AGENTS.md': 'New' });
  expect(derived.schema).toBe('spawnfile.training.candidate.v1');
  expect(derived.baselineId).toBe(id);
  expect(() => validateCandidate(derived)).not.toThrow();
  expect(() => validateCandidate({ ...candidate, schema: 'spawnfile.training.candidate.v1' })).not.toThrow();
  expect(() => validateCandidate({ ...candidate, resources: [{ ...resources[0]!, content: 'Tampered' }] })).toThrow('digest mismatch');
});

it('routes legacy cost-only projections through planning and refuses them before trial execution', async () => {
  const projected = (name: string, groups: string[]) => projectDatasetCost(resolveDataset(parseDatasetYaml(JSON.stringify({
    schema: 'spawnfile.training.dataset.v1', id: name, checks: [{ id: 'ok', eval: 'equals', input: 'output.text', value: 'Hello' }],
    records: groups.map(group => ({ id: `${name}-${group}`, group, input: { prompt: 'Hello' } })),
  }))));
  const train = projected('train', ['a', 'b', 'c']), test = projected('test', ['z']);
  const options = { train, test, subjectModel: 'model', optimizerModel: 'optimizer', judges: {}, maxTrials: 10, maxProposals: 2 };
  const legacy = { ...train, schema: 'paideia.cost-dataset.v1' } as unknown as CostDataset;
  expect(planTrainingCost({ ...options, train: legacy })).toEqual(planTrainingCost(options));
  await expect(runStoredTrial({ record: { schema: 'paideia.cost-record.v1' } } as unknown as StoredTrialOptions))
    .rejects.toThrow('Cost-only records cannot execute trials');
});
