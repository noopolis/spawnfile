import { describe, expect, it } from 'vitest';
import { inEscalationBand, planEscalation, escalationTeacherReport } from './index.js';
import type { CascadeRecord } from './index.js';

function rows(): CascadeRecord[] {
  return Array.from({ length: 40 }, (_, index) => ({ questionId: 'q', type: 'yes-no',
    group: `g${index}`, good: index < 20, p: index < 20 ? 0.9 : 0.1, rawPGood: 0.5, source: 'human' }));
}

describe('escalation planning', () => {
  it('uses inclusive fixed bands and records missing teacher answers as wrong', () => {
    const fit = rows(), held = rows();
    expect(inEscalationBand(0.4, [0.4, 0.6])).toBe(true);
    expect(inEscalationBand(0.6, [0.4, 0.6])).toBe(true);
    held[0]!.p = 0.5;
    const result = planEscalation(fit, held, { between: [0.4, 0.6] });
    expect(result).toMatchObject({ status: 'feasible', heldOutAccuracy: 0.975, escalationRate: 0.025, coverage: 0.975 });
    held[0]!.teacherGood = true;
    expect(planEscalation(fit, held, { between: [0.4, 0.6] }).heldOutAccuracy).toBe(1);
    expect(planEscalation([], [], { between: [0.4, 0.6] })).toMatchObject({ fitAccuracy: 0, coverage: 0, escalationRate: 0 });
  });
  it('selects narrowest grid band on fit alone and enforces held-out cascade accuracy', () => {
    const fit = rows();
    // Only a band covering 0.5 can remove these local errors.
    fit.slice(0, 10).forEach(row => { row.good = false; row.p = 0.5; });
    const held = fit.map(row => ({ ...row }));
    const result = planEscalation(fit, held, { target_accuracy: 1 });
    expect(result.band).toEqual([0.45, 0.5]);
    expect(result.fitAccuracy).toBe(1);
    expect(result.status).toBe('escalation-infeasible');
    expect(result.failures).toContain('heldOut.cascadeAccuracy >= target_accuracy - 0.03');
    held.slice(0, 10).forEach(row => { row.teacherGood = false; });
    expect(planEscalation(fit, held, { target_accuracy: 1 })).toMatchObject({ status: 'feasible', heldOutAccuracy: 1 });
  });
  it('enforces retained coverage in fit and held-out', () => {
    const fit = rows();
    fit.slice(0, 10).forEach(row => { row.good = false; row.p = 0.5; });
    const held = fit.map(row => ({ ...row, p: 0.5, teacherGood: row.good }));
    expect(planEscalation(fit, held, { target_accuracy: 1 }).failures).toContain('heldOut.retainedCoverage >= 0.30');
    const impossible = rows().map(row => ({ ...row, p: 0.5, good: false }));
    expect(planEscalation(impossible, held, { target_accuracy: 1 }).status).toBe('escalation-infeasible');
    expect(planEscalation([], [], { target_accuracy: 0.9 }).band).toBeUndefined();
    // Exactly 30% retained groups is enough.
    const boundary = rows().slice(0, 10).map((row, index) => ({ ...row, p: index < 7 ? 0.5 : 0.9,
      good: index >= 7, teacherGood: index >= 7 }));
    expect(planEscalation(boundary, boundary, { target_accuracy: 1 })).toMatchObject({ status: 'feasible', coverage: 0.3 });
  });
  it('reports teacher-golden overlap and prefers human adjudication for agreement', () => {
    const held = rows().map(row => ({ ...row, source: 'consensus' as const, teacherGood: row.good, goldenLabelers: ['teacher'] }));
    const human: CascadeRecord = { ...held[0]!, source: 'human', teacherGood: false, goldenLabelers: ['human'] };
    const result = planEscalation(rows(), [human, ...held], { between: [0.4, 0.6] }, { teacherId: 'teacher' });
    expect(result.teacherReport).toMatchObject({ agreement: 0, instances: 1, source: 'human',
      warnings: ['Escalation teacher contributed golden labels; held-out agreement may be biased upward.'] });
    expect(escalationTeacherReport(held, 'other')).toMatchObject({ agreement: 1, source: 'all', warnings: [] });
    expect(escalationTeacherReport([], 'other').agreement).toBe(0);
    expect(escalationTeacherReport(rows(), 'teacher').warnings).toEqual(['Golden labeler identities are unobserved.']);
    expect(planEscalation([], [], { target_accuracy: 1 }, { teacherId: 'teacher' }).teacherReport).toBeDefined();
  });
  it('rejects invalid configuration and probabilities', () => {
    for (const between of [[0.5, 0.5], [-1, 0.5], [0, 1.1], [0, NaN]] as const) {
      expect(() => planEscalation([], [], { between })).toThrow('between');
    }
    for (const target_accuracy of [0.5, 1.1, NaN]) expect(() => planEscalation([], [], { target_accuracy })).toThrow('target_accuracy');
    expect(() => planEscalation([{ ...rows()[0]!, p: NaN }], [], { target_accuracy: 1 })).toThrow('p:');
  });
});
