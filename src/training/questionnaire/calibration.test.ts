import { describe, expect, it } from 'vitest';
import { calibrationExpectationSchema, calibrationSetSchema, checkQuestionnaireCalibration } from './calibration.js';
import { runQuestionnaire } from './run.js';
import { parseBank } from './bank.js';
import { testBank, testBankYaml, testJudge, testMaterial, testReplies } from './testSupport.js';

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
  it('fails on a targeted question raised on a clean output that is no variant\'s base', async () => {
    const clean = await grade(testReplies[0]!), alarm = await grade(testReplies[0]!, { padding: { answer: 'paragraph', reason: 'P2' }, unused: { answer: 2, reason: 'x' } });
    const padded = await grade(testReplies[0]!, { padding: { answer: 'paragraph', reason: 'P3' }, unused: { answer: 2, reason: 'x' } });
    const one = calibrationExpectationSchema.parse([{ id: 'padded', base: 'clean', defect: 'padding', targets: ['padding'], gate_must_fail: false }]);
    expect(checkQuestionnaireCalibration(one, { clean, padded, other: clean }, ['other'])).toMatchObject({ ok: true, cleanFalseAlarms: [] });
    expect(checkQuestionnaireCalibration(one, { clean, padded, other: alarm }, ['other'])).toMatchObject({ ok: false, caught: 1, cleanBasesFailing: [],
      cleanFalseAlarms: [{ output: 'other', question: 'padding', answer: 'paragraph' }] });
  });
  it('counts a base that never answered the target as caught only when the variant scored', async () => {
    const na = await grade({ ...testReplies[0]!, quotes: { answer: 'na', reason: '' } });
    const changed = await grade({ ...testReplies[0]!, quotes: { answer: 'yes', reason: 'changed' } });
    const one = calibrationExpectationSchema.parse([{ id: 'v', base: 'b', defect: 'quote', targets: ['quotes'], gate_must_fail: false }]);
    expect(checkQuestionnaireCalibration(one, { b: na, v: changed })).toMatchObject({ ok: true, caught: 1 });
    expect(checkQuestionnaireCalibration(one, { b: changed, v: na })).toMatchObject({ ok: false, caught: 0 });
  });
  it('holds further clean outputs to a passing gate and counts a missing one', async () => {
    const clean = await grade(testReplies[0]!), failing = await grade({ ...testReplies[0]!, figures: { answer: 'no', reason: 'x' } });
    expect(checkQuestionnaireCalibration([], { good: clean }, ['good'])).toMatchObject({ ok: true, defects: 0, cleanBases: 1 });
    expect(checkQuestionnaireCalibration([], { good: failing }, ['good'])).toMatchObject({ ok: false, cleanBasesFailing: ['good'] });
    expect(checkQuestionnaireCalibration([], {}, ['good'])).toMatchObject({ ok: false, missing: ['good'] });
  });
  it('validates a declared calibration set', () => {
    const set = { schema: 'spawnfile.training.calibration.v1', check: 'house', outputs: [{ id: 'clean', output: 'outputs/clean.json', context: { evidence: 'cases/a/evidence.json' } }, { id: 'figure', output: 'outputs/figure.json' }],
      expect: [{ id: 'figure', base: 'clean', defect: 'figure', targets: ['figures'], gate_must_fail: true }] };
    expect(calibrationSetSchema.parse(set).outputs).toHaveLength(2);
    expect(calibrationSetSchema.parse({ ...set, expect: undefined, clean: ['clean'] }).clean).toEqual(['clean']);
    for (const broken of [{ ...set, expect: undefined }, { ...set, clean: ['absent'] }, { ...set, outputs: [set.outputs[0], set.outputs[0]] }, { ...set, outputs: [set.outputs[0]] },
      { ...set, outputs: [{ id: 'clean', output: '../clean.json' }, set.outputs[1]] }, { ...set, schema: 'other' }, { ...set, extra: true }]) {
      expect(calibrationSetSchema.safeParse(broken).success).toBe(false);
    }
  });
});

describe('questionnaire calibration on the ladder', () => {
  const laddered = parseBank(testBankYaml.replace('instructions: "You are a strict checker."', 'instructions: "You are a strict checker."\npenalty: 0.5'));
  const gradeLadder = (first: Record<string, unknown>) => runQuestionnaire({ bank: laddered, material: testMaterial, judges: { strong: testJudge([first, testReplies[1]!]) } });
  it('requires a known-bad output to score strictly below its clean base', async () => {
    const only = expectations.slice(0, 1);
    const clean = await gradeLadder(testReplies[0]!), figure = await gradeLadder({ ...testReplies[0]!, figures: { answer: 'no', reason: 'x' } });
    const report = checkQuestionnaireCalibration(only, { clean, figure });
    expect(report).toMatchObject({ ok: true, search: { clean: clean.search, defects: figure.search, notBelowBase: [] } });
    expect(figure.search!).toBeLessThan(clean.search!);
    const flat = { ...figure, search: clean.search };
    expect(checkQuestionnaireCalibration(only, { clean, figure: flat })).toMatchObject({ ok: false, search: { notBelowBase: ['figure'] } });
    expect(checkQuestionnaireCalibration(only, { clean: await grade(testReplies[0]!), figure: await grade({ ...testReplies[0]!, figures: { answer: 'no', reason: 'x' } }) }).search).toBeUndefined();
  });
});
