import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGrader } from './grader.js';
import { loadLabels, parseLabels, parseLabelsYaml } from './labels.js';
import { sha256 } from './common.js';

const grader = parseGrader({
  schema: 'paideia.grader.v1', id: 'g', golden: 'l', calibration: 'c',
  teachers: [{ id: 'c', provider: 'claude', model: 'm' }], model: { backend: 'teacher', teacher: 'c' },
  escalate: { to: 'c', between: [0, 1] }, score: { method: 'weighted' },
  context: { evidence: { description: '' } },
  questions: [
    { id: 'a', type: 'yes-no', expected: 'yes', reads: [] },
    { id: 'p', level: 'paragraph', type: 'choice', options: ['x', 'y'], expected: ['x'], reads: [], when: 'Applies?' },
    { id: 's', level: 'sentence', type: 'score', scale: [1, 5], expected: '>= 4', reads: [] },
  ],
});
const base = {
  schema: 'paideia.labels.v1', grader: 'g',
  labelers: { c: { kind: 'model', provider: 'claude', model: 'm' }, h: { kind: 'human', name: 'Human' } },
  labels: [{ id: 'l', lineage: 'family', output: { body: ['Hello.'] }, context: { evidence: 'truth' },
    votes: { a: { c: 'yes', h: 'abstain' }, 'p@p0': { c: 'x' }, 'p.applies@p0': { c: 'yes' }, 's@p0.s0': { c: 4 } },
    asked: ['c', 'h'], provenance: { c: { reported_model: 'm', at: 'time' } } }],
};
function withLabel(change: Record<string, unknown>) { return { ...base, labels: [{ ...base.labels[0], ...change }] }; }

describe('labels', () => {
  it('validates typed instance votes, references and provenance', () => {
    expect(parseLabels(base, grader).labels[0]?.votes['s@p0.s0']).toEqual({ c: 4 });
    expect(parseLabelsYaml(JSON.stringify(base), grader).labels).toHaveLength(1);
    expect(parseLabels(withLabel({ asked: undefined }), grader).labels[0]?.asked).toBeUndefined();
  });
  it.each([
    ['unknown', 'yes', 'unknown question'], ['a@p0', 'yes', 'suffix'], ['p', 'x', 'suffix'],
    ['p@p0.s0', 'x', 'suffix'], ['s@p0', 3, 'suffix'], ['a.applies', 'yes', 'unknown question'],
    ['a', 'invalid', 'invalid option'], ['s@p0.s0', '4', 'invalid option'], ['s@p0.s0', 6, 'invalid option'],
  ])('rejects %s=%s (%s)', (key, vote, error) => {
    expect(() => parseLabels(withLabel({ votes: { [key]: { c: vote } } }), grader)).toThrow(error);
  });
  it('rejects invalid labels and unknown maps', () => {
    expect(() => parseLabels({ ...base, grader: 'other' }, grader)).toThrow('$.grader');
    expect(() => parseLabels({ ...base, labelers: { c: { kind: 'model', provider: 'codex', model: 'm' } } }, grader))
      .toThrow('codex exec has no native empty-tool attestation');
    expect(() => parseLabels({ ...base, labels: [base.labels[0], base.labels[0]] }, grader)).toThrow('labels.1.id');
    expect(() => parseLabels(withLabel({ lineage: undefined }), grader)).toThrow('lineage');
    expect(() => parseLabels(withLabel({ asked: ['unknown'] }), grader)).toThrow('asked/provenance.unknown');
    expect(() => parseLabels(withLabel({ votes: { a: { unknown: 'yes' } } }), grader)).toThrow('votes.a.unknown');
    expect(() => parseLabels(withLabel({ context: { unknown: 'value' } }), grader)).toThrow('context.unknown');
    expect(() => parseLabels(withLabel({ output: { from: 'a.json', sha256: 'wrong' } }), grader)).toThrow('labels.0.output');
    expect(() => parseLabels(withLabel({ context: { evidence: { from: 'f' } } }), grader)).toThrow('context.evidence');
    expect(() => parseLabels(JSON.parse(JSON.stringify(base).replace('"c":{"kind"', '"__proto__":{"kind"')), grader)).toThrow('unsafe');
  });
  it('verifies content-addressed bytes and names the label on mismatch', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'labels-'));
    try {
      const output = JSON.stringify({ body: ['Hello.'] });
      await writeFile(path.join(directory, 'output.json'), output);
      await writeFile(path.join(directory, 'context.md'), 'truth');
      const labelFile = path.join(directory, 'labels.yaml');
      const addressed = withLabel({ output: { from: 'output.json', sha256: sha256(output) }, context: { evidence: { from: 'context.md', sha256: sha256('truth') } } });
      await writeFile(labelFile, JSON.stringify(addressed));
      const loaded = await loadLabels(labelFile, grader);
      expect(loaded.labels.labels[0]).toMatchObject({ output: { body: ['Hello.'] }, context: { evidence: 'truth' } });
      expect(loaded.goldenDigest).toMatch(/^[a-f0-9]{64}$/);
      const unsafeOutput = '{"constructor":{}}';
      await writeFile(path.join(directory, 'unsafe.json'), unsafeOutput);
      await writeFile(labelFile, JSON.stringify(withLabel({ output: { from: 'unsafe.json', sha256: sha256(unsafeOutput) } })));
      await expect(loadLabels(labelFile, grader)).rejects.toThrow('label l.constructor: unsafe map key');
      await writeFile(labelFile, JSON.stringify(addressed));
      await writeFile(path.join(directory, 'context.md'), 'changed');
      await expect(loadLabels(labelFile, grader)).rejects.toThrow('label l: sha256 mismatch');
      await writeFile(labelFile, JSON.stringify(withLabel({ output: null, context: { evidence: ['inline'] } })));
      expect((await loadLabels(labelFile, grader)).labels.labels[0]?.output).toBeNull();
      await writeFile(labelFile, JSON.stringify(base));
      expect((await loadLabels(labelFile, grader)).labels.labels[0]?.context.evidence).toBe('truth');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
