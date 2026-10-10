import { describe, expect, it } from 'vitest';
import { parseGrader, type Labels } from './format/index.js';
import { createCalibrationIdentity, parseCalibration, parseCalibrationJson, checkCalibration, segmenterIdentity, goldenIdentity,
  type CalibrationFile } from './identity.js';

const grader = parseGrader({ schema: 'paideia.grader.v1', id: 'g', golden: 'g', calibration: 'c',
  teachers: [{ id: 't', provider: 'claude', model: 'm' }], model: { backend: 'teacher', teacher: 't' },
  escalate: { to: 't', between: [0, 1] }, score: { method: 'weighted' },
  questions: [{ id: 'q', type: 'yes-no', expected: 'yes', reads: [], when: 'Applies?' }] });
const supplied = { promptTemplateVersion: 'v1', backendModel: 'teacher:t:m', golden: 'a'.repeat(64), seed: 'seed', exclusions: [{ dataset: 'test', digest: 'b'.repeat(64) }] };
const identity = createCalibrationIdentity(grader, supplied);
function calibration(): CalibrationFile {
  return parseCalibration({ schema: 'paideia.grader-calibration.v1', identity,
    questions: Object.fromEntries(['q', 'q.applies'].map(id => [id, { status: 'calibrated', failures: [],
      params: { a: 1, b: 0 }, band: [0.4, 0.6], metrics: { groups: 20, instances: 40, good: 20, bad: 20, baseRate: 0.5,
        accuracy: 1, brier: 0.01, baseRateBrier: 0.25, ece: 0.1, eceInterval: [0, 0.15], brierInterval: [0, 0.1] } }])) });
}
describe('calibration identities', () => {
  it('pins all definition, option, golden and supplied runtime identities', () => {
    expect(identity.questions['q.applies']).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.optionMapping.q).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.segmenter).toBe(segmenterIdentity());
    expect(createCalibrationIdentity(grader, { ...supplied, segmenter: 'custom' }).segmenter).toBe('custom');
    expect(checkCalibration(grader, calibration(), identity)).toEqual({ ok: true, refusals: [], notCalibrated: [] });
    expect(parseCalibrationJson(JSON.stringify(calibration()))).toEqual(calibration());
    expect(goldenIdentity({ labels: [] } as unknown as Labels)).not.toBe(goldenIdentity({ labels: [1] } as unknown as Labels));
  });
  it.each(['questions', 'optionMapping', 'promptTemplateVersion', 'segmenter', 'backendModel', 'golden', 'seed', 'exclusions'] as const)(
    'refuses a mismatch naming %s', component => {
      const file = calibration();
      const mutated = { ...file, identity: { ...file.identity, [component]: component === 'questions' || component === 'optionMapping'
        ? { q: 'c'.repeat(64) } : component === 'exclusions' ? [] : 'changed' } } as CalibrationFile;
      expect(checkCalibration(grader, mutated, identity).refusals).toContain(`calibration identity mismatch: ${component}`);
    });
  it('recomputes question identity from grader and reports uncalibrated derived questions', () => {
    const changed = { ...grader, questions: grader.questions.map(q => ({ ...q, ask: 'changed' })) };
    expect(checkCalibration(changed, calibration(), identity).refusals).toContain('calibration identity mismatch: questions');
    const file = calibration();
    file.questions.q!.status = 'insufficient-evidence';
    file.questions.q!.failures = ['evidence.groups >= 15'];
    delete file.questions['q.applies'];
    expect(checkCalibration(grader, file, identity)).toEqual({ ok: false, notCalibrated: ['q', 'q.applies'],
      refusals: ['question q: evidence.groups >= 15', 'question q.applies: not calibrated'] });
    expect(checkCalibration({ ...grader, uncalibrated: 'teacher' }, file, identity)).toMatchObject({ ok: true, notCalibrated: ['q', 'q.applies'] });
    file.identity.seed = 'other';
    expect(checkCalibration({ ...grader, uncalibrated: 'teacher' }, file, identity).ok).toBe(false);
  });
  it('rejects invalid schema version, probabilities, bands and unsafe IDs', () => {
    const file = calibration();
    expect(() => parseCalibration({ ...file, schema: 'other' })).toThrow('schema');
    expect(() => parseCalibration({ ...file, questions: { q: { ...file.questions.q, band: [0.5, 0.5] } } })).toThrow('band');
    expect(() => parseCalibration({ ...file, questions: { q: { ...file.questions.q, metrics: { ...file.questions.q!.metrics, eceInterval: [0.5, 0.1] } } } })).toThrow('eceInterval');
    expect(() => parseCalibration({ ...file, questions: JSON.parse('{"__proto__":{}}') })).toThrow('unsafe');
    expect(() => parseCalibration({ ...file, identity: { ...identity, golden: 'bad' } })).toThrow('golden');
  });
});
