import '../../../../fixtures/support/training/graderProviders.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parseGrader } from './grader.js';
import { loadLabels, parseLabels } from './labels.js';
import { sha256, stableDigest } from './common.js';
import { createCalibrationIdentity, parseCalibration, checkCalibration } from '../index.js';

it('reads historical golden labels and still verifies their exact addressed source bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legacy-labels-'));
  try {
    const grader = parseGrader({ schema: 'paideia.grader.v1', id: 'g', golden: 'labels.yaml', calibration: 'c',
      teachers: [{ id: 't', provider: 'claude', model: 'm' }], model: { backend: 'teacher', teacher: 't' },
      escalate: { to: 't', between: [0, 1] }, score: { method: 'weighted' }, context: {},
      questions: [{ id: 'q', type: 'yes-no', expected: 'yes', reads: [] }] });
    const output = '{"body":"Original"}';
    const file = join(root, 'labels.yaml');
    const source = { schema: 'paideia.labels.v1', grader: 'g', labelers: { h: { kind: 'human', name: 'Human' } },
      labels: [{ id: 'l', lineage: 'group', output: { from: 'output.json', sha256: sha256(output) }, context: {},
        votes: { q: { h: 'yes' } }, provenance: {} }] };
    await writeFile(join(root, 'output.json'), output);
    await writeFile(file, JSON.stringify(source));
    const loaded = await loadLabels(file, grader);
    expect(loaded.labels.schema).toBe('spawnfile.training.labels.v1');
    expect(loaded.labels.labels[0]?.output).toEqual({ body: 'Original' });
    expect(parseLabels(source, grader).schema).toBe('spawnfile.training.labels.v1');
    expect(() => parseLabels({ ...source, extra: true }, grader)).toThrow();
    await writeFile(join(root, 'output.json'), '{"body":"Modified"}');
    await expect(loadLabels(file, grader)).rejects.toThrow('sha256 mismatch');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('reads an old calibration and golden corpus but explicitly refuses their rotated semantic identity', () => {
  const grader = parseGrader({ schema: 'paideia.grader.v1', id: 'g', golden: 'labels.yaml', calibration: 'c',
    teachers: [{ id: 't', provider: 'claude', model: 'm' }], model: { backend: 'teacher', teacher: 't' },
    escalate: { to: 't', between: [0, 1] }, score: { method: 'weighted' }, context: {},
    questions: [{ id: 'q', type: 'yes-no', expected: 'yes', reads: [] }] });
  const source = { schema: 'paideia.labels.v1', grader: 'g', labelers: {}, labels: [] };
  const labels = parseLabels(source, grader);
  const supplied = { promptTemplateVersion: 'current', backendModel: 'teacher:t:m', golden: stableDigest(source), seed: '0', exclusions: [] };
  const original = createCalibrationIdentity(grader, supplied);
  const calibration = parseCalibration({ schema: 'paideia.grader-calibration.v1', identity: original,
    questions: { q: { status: 'calibrated', failures: [], metrics: { groups: 0, instances: 0, good: 0, bad: 0, baseRate: 0 } } } });
  expect(calibration.schema).toBe('spawnfile.training.grader-calibration.v1');
  expect(checkCalibration(grader, calibration, original, { quality: false }).ok).toBe(true);
  expect(stableDigest(labels)).not.toBe(original.golden);
  const checked = checkCalibration(grader, calibration, { ...original, golden: stableDigest(labels) }, { quality: false });
  expect(checked.ok).toBe(false);
  expect(checked.refusals).toContain('calibration identity mismatch: golden');
  expect(checked.refusals.join('; ')).toMatch(/re-prepare with Spawnfile/i);
  expect(calibration.identity.golden).toBe(stableDigest(source));
});
