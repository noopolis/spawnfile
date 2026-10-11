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
  it('refuses schedule-changing question and gate reorders while preserving authored expansion', () => {
    const q = grader.questions[0]!;
    const original = { ...grader, questions: [{ ...q, id: 'a' }, { ...q, id: 'b' }],
      gates: [{ ...q, id: 'c' }, { ...q, id: 'd' }], escalate: { ...grader.escalate, max_calls_per_trial: 1 } };
    const pinned = createCalibrationIdentity(original, supplied);
    const file = { ...calibration(), identity: pinned };
    expect(pinned.expansion.map(([id]) => id)).toEqual(['a', 'a.applies', 'b', 'b.applies', 'c', 'c.applies', 'd', 'd.applies']);
    expect(checkCalibration(original, file, pinned, { quality: false }).ok).toBe(true);
    for (const changed of [{ ...original, questions: [...original.questions].reverse() },
      { ...original, gates: [...original.gates].reverse() }]) {
      expect(checkCalibration(changed, file, pinned, { quality: false })).toMatchObject({ ok: false,
        refusals: ['calibration identity mismatch: expansion'] });
    }
  });
  it('pins all definition, option, golden and supplied runtime identities', () => {
    expect(identity.questions['q.applies']).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.optionMapping.q).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.segmenter).toBe(segmenterIdentity());
    expect(createCalibrationIdentity(grader, { ...supplied, segmenter: 'custom' }).segmenter).toBe('custom');
    expect(checkCalibration(grader, calibration(), identity)).toEqual({ ok: true, refusals: [], notCalibrated: [] });
    expect(parseCalibrationJson(JSON.stringify(calibration()))).toEqual(calibration());
    expect(goldenIdentity({ labels: [] } as unknown as Labels)).not.toBe(goldenIdentity({ labels: [1] } as unknown as Labels));
  });
  it.each(['questions', 'optionMapping', 'promptTemplateVersion', 'segmenter', 'backendModel', 'golden', 'seed', 'exclusions', 'escalation', 'escalationTeacher', 'uncalibrated'] as const)(
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
    expect(checkCalibration(grader, file, identity, { quality: false }).ok).toBe(true);
    const fallback = { ...grader, uncalibrated: 'teacher' as const };
    expect(checkCalibration(fallback, file, identity).ok).toBe(false);
    file.identity = createCalibrationIdentity(fallback, supplied);
    expect(checkCalibration(fallback, file, file.identity)).toMatchObject({ ok: true, notCalibrated: ['q', 'q.applies'] });
    file.identity.seed = 'other';
    expect(checkCalibration({ ...grader, uncalibrated: 'teacher' }, file, identity).ok).toBe(false);
  });
  it('pins every escalation route, band, target, budget, teacher policy and fallback change', () => {
    const original = { ...grader, teachers: [...grader.teachers, { id: 'other', provider: 'grok' as const, model: 'grok' }] };
    const file = calibration();
    file.identity = createCalibrationIdentity(original, supplied);
    const changed = [
      { ...original, escalate: { ...original.escalate, to: 'other' } },
      { ...original, escalate: { ...original.escalate, max_calls_per_trial: 1 } },
      { ...original, escalate: { to: 't', between: [0.2, 0.8] as [number, number] } },
      { ...original, escalate: { to: 't', target_accuracy: 0.99 } },
      { ...original, teachers: original.teachers.map(t => ({ ...t, model: 'changed' })) },
      { ...original, uncalibrated: 'teacher' as const },
    ];
    for (const definition of changed) {
      expect(checkCalibration(definition, file, file.identity).ok).toBe(false);
      const fresh = createCalibrationIdentity(definition, supplied);
      expect(checkCalibration(definition, { ...file, identity: fresh }, fresh).ok).toBe(true);
    }
    const target = { ...original, escalate: { to: 't', target_accuracy: 0.85, max_calls_per_trial: 2 } };
    file.identity = createCalibrationIdentity(target, supplied);
    expect(checkCalibration({ ...target, escalate: { ...target.escalate, target_accuracy: 0.99 } }, file, file.identity).ok).toBe(false);
    expect(checkCalibration({ ...target, escalate: { ...target.escalate, max_calls_per_trial: 1 } }, file, file.identity).ok).toBe(false);
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
