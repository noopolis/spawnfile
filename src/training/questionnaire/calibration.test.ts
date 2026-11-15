import { describe, expect, it } from 'vitest';
import { calibrationExpectationSchema, checkQuestionnaireCalibration } from './calibration.js';
import { runQuestionnaire } from './run.js';
import { testBank, testJudge, testMaterial, testReplies } from './testSupport.js';

const grade = (first: Record<string, unknown>, second: Record<string, unknown> = testReplies[1]!) =>
  runQuestionnaire({ bank: testBank(), material: testMaterial, judges: { strong: testJudge([first, second]) } });
const expectations = calibrationExpectationSchema.parse([
  { id: 'figure', base: 'clean', defect: 'figure', targets: ['figures'], gate_must_fail: true },
  { id: 'padded', base: 'clean', defect: 'padding', injected: 'a paragraph', targets: ['padding', 'absent'], gate_must_fail: false },
]);

describe('questionnaire calibration', () => {
  it('passes when every defect is caught, required gates fail and clean bases pass', async () => {
    const results = { clean: await grade(testReplies[0]!), figure: await grade({ ...testReplies[0]!, figures: { answer: 'no', reason: 'x' } }),
      padded: await grade(testReplies[0]!, { padding: { answer: 'paragraph', reason: 'P3' }, unused: { answer: 2, reason: 'x' } }) };
    const report = checkQuestionnaireCalibration(expectations, results);
    expect(report).toMatchObject({ ok: true, defects: 2, caught: 2, gateRequired: 1, gateFailed: 1, cleanBases: 1, cleanBasesFailing: [], missing: [] });
    expect(report.rows[1]!.targets).toEqual([{ id: 'padding', base: 'clause', variant: 'paragraph' }, { id: 'absent', base: null, variant: null }]);
  });
  it('fails on a missed defect, an unfailed gate, a failing clean base or a missing result', async () => {
    const clean = await grade(testReplies[0]!);
    expect(checkQuestionnaireCalibration(expectations, { clean, figure: clean, padded: clean })).toMatchObject({ ok: false, caught: 0, gateFailed: 0 });
    const failing = await grade({ ...testReplies[0]!, figures: { answer: 'no', reason: 'x' } });
    expect(checkQuestionnaireCalibration(expectations, { clean: failing, figure: failing, padded: failing })).toMatchObject({ ok: false, cleanBasesFailing: ['clean'] });
    expect(checkQuestionnaireCalibration(expectations, { clean })).toMatchObject({ ok: false, missing: ['figure', 'padded'] });
    expect(checkQuestionnaireCalibration(expectations, { figure: failing })).toMatchObject({ ok: false, missing: ['clean', 'padded'], cleanBases: 0 });
  });
  it('counts a base that never answered the target as caught only when the variant scored', async () => {
    const na = await grade({ ...testReplies[0]!, quotes: { answer: 'na', reason: '' } });
    const changed = await grade({ ...testReplies[0]!, quotes: { answer: 'yes', reason: 'changed' } });
    const one = calibrationExpectationSchema.parse([{ id: 'v', base: 'b', defect: 'quote', targets: ['quotes'], gate_must_fail: false }]);
    expect(checkQuestionnaireCalibration(one, { b: na, v: changed })).toMatchObject({ ok: true, caught: 1 });
    expect(checkQuestionnaireCalibration(one, { b: changed, v: na })).toMatchObject({ ok: false, caught: 0 });
  });
});
