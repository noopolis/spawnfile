import { describe, expect, it } from 'vitest';
import { calibrationBars, calibrationMetrics, expectedCalibrationError, groupBootstrap, teacherAgreement } from './index.js';
import type { CalibrationMetrics, ScoredRecord, TeacherAgreementRecord } from './index.js';

function rows(count = 30): ScoredRecord[] {
  return Array.from({ length: count }, (_, index) => ({ questionId: 'q', type: 'yes-no',
    group: `g${Math.floor(index / 2)}`, good: index % 2 === 0, rawPGood: 0.5,
    p: index % 2 === 0 ? 0.95 : 0.05, source: 'human' }));
}
const passing: CalibrationMetrics = { groups: 15, instances: 30, good: 25, bad: 5,
  baseRate: 0.5, accuracy: 1, brier: 0.20, baseRateBrier: 0.25, ece: 0.10,
  eceInterval: [0.01, 0.15], brierInterval: [0.1, 0.25], falsePassRate: 0.10 };

describe('held-out metrics', () => {
  it('computes accuracy, Brier, fit base-rate Brier and conditional gate false-pass rate', () => {
    const result = calibrationMetrics(rows(), 0.25, 'seed', true);
    expect(result).toMatchObject({ groups: 15, instances: 30, good: 15, bad: 15,
      baseRate: 0.25, accuracy: 1, baseRateBrier: 0.3125, falsePassRate: 0 });
    expect(result.brier).toBeCloseTo(0.0025);
    const bad = rows().map(row => ({ ...row, p: 1 }));
    expect(calibrationMetrics(bad, 0.5, 's', true).falsePassRate).toBe(1);
    expect(calibrationMetrics(rows().map(row => ({ ...row, good: true })), 0.5, 's', true).falsePassRate).toBe(0);
    expect(calibrationMetrics([], 0, 's', true)).toMatchObject({ accuracy: 0, brier: 1, ece: 1 });
    expect(() => calibrationMetrics([], NaN, 's')).toThrow('baseRate');
    expect(() => calibrationMetrics([{ ...rows()[0]!, p: -1 }], 0.5, 's')).toThrow('p:');
  });
  it('uses equal-mass bins of at least ten and no more than ten bins', () => {
    expect(expectedCalibrationError(rows(9))).toBe(1);
    expect(expectedCalibrationError(Array.from({ length: 19 }, () => ({ p: 0.4, good: true })))).toBeCloseTo(0.6);
    expect(expectedCalibrationError(rows(200))).toBeCloseTo(0.05);
  });
  it('bootstraps whole lineages rather than individual instances', () => {
    const clustered = rows(200).map((row, index) => ({ ...row, group: index < 100 ? 'A' : 'B',
      p: 0, good: index < 100 }));
    // Drawing both copies of A or B gives extrema with 25% probability each.
    // An instance bootstrap would concentrate tightly around 0.5 instead.
    const bootstrap = groupBootstrap(clustered, 'groups');
    expect(bootstrap.brierInterval).toEqual([0, 1]);
    expect(bootstrap.eceInterval).toEqual([0, 1]);
    expect(groupBootstrap(clustered, 'groups')).toEqual(bootstrap);
    expect(groupBootstrap([], 's')).toEqual({ eceInterval: [1, 1], brierInterval: [1, 1] });
  });
});

describe('calibration bars', () => {
  it('accepts exact boundaries and rejects each failure naming its bar', () => {
    expect(calibrationBars(passing)).toEqual({ status: 'calibrated', failures: [] });
    const evidence = [['groups', 14], ['instances', 29], ['good', 4], ['bad', 4]] as const;
    for (const [field, value] of evidence) {
      const result = calibrationBars({ ...passing, [field]: value });
      expect(result.status).toBe('insufficient-evidence');
      expect(result.failures.some(failure => failure.includes(`evidence.${field}`))).toBe(true);
    }
    for (const [change, bar] of [
      [{ ece: 0.1001 }, 'calibration.ece'], [{ eceInterval: [0, 0.1501] }, 'calibration.ece90Upper'],
      [{ brier: 0.2001 }, 'calibration.brier'], [{ baseRateBrier: 0.2 }, 'baseRateBrier'],
      [{ falsePassRate: 0.1001 }, 'gate.falsePassRate'],
    ] as const) {
      const result = calibrationBars({ ...passing, ...change } as CalibrationMetrics);
      expect(result.status).toBe('uncalibrated');
      expect(result.failures.some(failure => failure.includes(bar))).toBe(true);
    }
    expect(calibrationBars({ ...passing, falsePassRate: undefined }).status).toBe('calibrated');
  });
});

describe('teacher-only calibration', () => {
  it('requires exact choice/score agreement even for different acceptable answers', () => {
    const cases: TeacherAgreementRecord[] = [
      { group: 'choice', good: true, goldenAnswer: 'related', teacherAnswer: 'no-figures', goldenLabelers: ['human'] },
      { group: 'score', good: true, goldenAnswer: 4, teacherAnswer: 5, goldenLabelers: ['human'] },
      { group: 'missing', good: false, goldenAnswer: 1, goldenLabelers: ['human'] },
      { group: 'exact', good: true, goldenAnswer: 5, teacherAnswer: 5, goldenLabelers: ['human'] },
    ];
    expect(teacherAgreement(cases, 'teacher')).toMatchObject({ agreement: 0.25, good: 3, bad: 1 });
  });
  it('requires independent labels, counts missing wrong, and enforces agreement 0.85', () => {
    const examples: TeacherAgreementRecord[] = rows(40).map((row, index) => ({ group: row.group,
      good: row.good, goldenAnswer: row.good ? 'yes' : 'no',
      teacherAnswer: (index < 34 ? row.good : !row.good) ? 'yes' : 'no', goldenLabelers: ['other'] }));
    expect(teacherAgreement(examples, 'teacher')).toMatchObject({ status: 'calibrated', agreement: 0.85 });
    examples[0]!.teacherAnswer = undefined;
    expect(teacherAgreement(examples, 'teacher')).toMatchObject({ status: 'uncalibrated', agreement: 0.825,
      failures: ['teacher.agreement >= 0.85'] });
    examples[0]!.goldenLabelers = ['teacher', 'other'];
    examples[1]!.goldenLabelers = [];
    expect(teacherAgreement(examples, 'teacher').excludedSelfLabels).toBe(2);
    expect(teacherAgreement([], 'teacher').status).toBe('insufficient-evidence');
  });
});
