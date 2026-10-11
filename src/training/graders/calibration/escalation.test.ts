import { describe, expect, it } from 'vitest';
import { inEscalationBand, planEscalation, escalationTeacherReport } from './index.js';
import type { CascadeRecord } from './index.js';

function rows(count = 40): CascadeRecord[] {
  return Array.from({ length: count }, (_, index) => ({ questionId: 'q', type: 'yes-no',
    group: `g${index}`, outputId: `o${index}`, projectionDigest: 'projection', good: index < count / 2,
    p: index < count / 2 ? 0.9 : 0.1, rawPGood: 0.5, source: 'human' }));
}
function modelRows(): CascadeRecord[] {
  return rows().map(row => ({ ...row, source: 'consensus', teacherGood: row.good,
    votes: { teacher: row.good ? 'yes' : 'no', other: row.good ? 'no' : 'yes' }, asked: ['teacher', 'other'],
    expected: ['yes'], labelers: { teacher: { kind: 'model', provider: 'claude', model: 'm' },
      other: { kind: 'model', provider: 'grok', model: 'm' } } }));
}

describe('escalation planning', () => {
  it('uses inclusive bands and records missing teacher answers as wrong', () => {
    const fit = rows(), held = rows();
    expect(inEscalationBand(0.4, [0.4, 0.6])).toBe(true);
    expect(inEscalationBand(0.6, [0.4, 0.6])).toBe(true);
    held[0]!.p = 0.5;
    expect(planEscalation(fit, held, { between: [0.4, 0.6] })).toMatchObject({
      status: 'calibrated', heldOutAccuracy: 0.975, escalationRate: 0.025, coverage: 0.975 });
    held[0]!.teacherGood = true;
    expect(planEscalation(fit, held, { between: [0.4, 0.6] }).heldOutAccuracy).toBe(1);
    expect(planEscalation([], [], { between: [0.4, 0.6] })).toMatchObject({
      status: 'unverified', fitAccuracy: 0, coverage: 0, escalationRate: 0, cascadeInterval: [0, 1] });
  });
  it('selects the narrowest grid band on fit alone and enforces the held-out point bar', () => {
    const fit = rows();
    fit.slice(0, 10).forEach(row => { row.good = false; row.p = 0.5; });
    const held = fit.map(row => ({ ...row }));
    const result = planEscalation(fit, held, { target_accuracy: 1 });
    expect(result.band).toEqual([0.45, 0.5]);
    expect(result.fitAccuracy).toBe(1);
    expect(result.status).toBe('escalation-infeasible');
    expect(result.failures).toContain('heldOut.cascadeAccuracy >= target_accuracy');
    held.slice(0, 10).forEach(row => { row.teacherGood = false; });
    expect(planEscalation(fit, held, { target_accuracy: 1 })).toMatchObject({ status: 'calibrated', heldOutAccuracy: 1 });
  });
  it('requires Wilson lower accuracy bound even when the point bar passes', () => {
    const held = rows(15);
    const result = planEscalation(rows(), held, { target_accuracy: 1 });
    expect(result.heldOutAccuracy).toBe(1);
    expect(result.status).toBe('escalation-infeasible');
    expect(result.failures).toContain('heldOut.cascade90Lower >= target_accuracy - 0.10');
    expect(result.cascadeInterval[0]).toBeLessThan(0.90);
  });
  it('enforces retained group coverage in fit and held-out', () => {
    const fit = rows();
    fit.slice(0, 10).forEach(row => { row.good = false; row.p = 0.5; });
    const held = fit.map(row => ({ ...row, p: 0.5, teacherGood: row.good }));
    expect(planEscalation(fit, held, { target_accuracy: 1 }).failures).toContain('heldOut.retainedCoverage >= 0.30');
    const impossible = rows().map(row => ({ ...row, p: 0.5, good: false }));
    expect(planEscalation(impossible, held, { target_accuracy: 1 }).status).toBe('escalation-infeasible');
    expect(planEscalation([], [], { target_accuracy: 0.9 }).band).toBeUndefined();
    const boundary = rows().map((row, index) => ({ ...row, p: index < 28 ? 0.5 : 0.9,
      good: index >= 28, teacherGood: index >= 28 }));
    expect(planEscalation(boundary, boundary, { target_accuracy: 1 })).toMatchObject({ status: 'calibrated', coverage: 0.3 });
  });
  it('derives golden answers without the escalation teacher vote', () => {
    const held = modelRows();
    const result = planEscalation(rows(), held, { between: [0.4, 0.6] }, { teacherId: 'teacher' });
    expect(result).toMatchObject({ independentGroups: 40, heldOutAccuracy: 0 });
    expect(result.teacherReport).toMatchObject({ agreement: 0, instances: 40, source: 'independent' });
    // Asked missing/abstaining teachers remain in the remaining-teacher denominator.
    held.forEach(row => { row.asked = ['teacher', 'other', 'missing'];
      row.labelers!.missing = { kind: 'model', provider: 'grok', model: 'm' }; });
    expect(planEscalation(rows(), held, { between: [0.4, 0.6] }, { teacherId: 'teacher' }))
      .toMatchObject({ status: 'unverified', independentGroups: 0 });
    held.forEach(row => { row.votes!.missing = 'abstain'; });
    expect(planEscalation(rows(), held, { between: [0.4, 0.6] }, { teacherId: 'teacher' }).status).toBe('unverified');
  });
  it('uses human override and refuses insufficient independent groups', () => {
    const held = modelRows();
    held.forEach(row => { row.labelers!.human = { kind: 'human', name: 'H' };
      row.votes!.human = row.good ? 'yes' : 'no'; row.asked = undefined; });
    expect(planEscalation(rows(), held, { target_accuracy: 1 }, { teacherId: 'teacher' })).toMatchObject({
      status: 'calibrated', heldOutAccuracy: 1 });
    const onlyTeacher = modelRows().map(row => ({ ...row, votes: { teacher: 'yes' }, asked: ['teacher'] }));
    expect(planEscalation(rows(), onlyTeacher, { target_accuracy: 1 }, { teacherId: 'teacher' }).status).toBe('unverified');
    const fourteen = [...rows(14), ...onlyTeacher];
    expect(planEscalation(rows(), fourteen, { target_accuracy: 0.9 }, { teacherId: 'teacher' })).toMatchObject({
      status: 'unverified', independentGroups: 14 });
    expect(planEscalation(rows(), modelRows(), { target_accuracy: 0.9 }).status).toBe('unverified');
    expect(escalationTeacherReport([], 'teacher').agreement).toBe(0);
    const human = { ...rows()[0]!, teacherGood: true };
    expect(escalationTeacherReport([human, ...onlyTeacher], 'teacher')).toMatchObject({ source: 'human', instances: 1,
      agreement: 1, warnings: ['Instances without independent golden answers are excluded from cascade verification.'] });
  });
  it('budgets one call per output projection, across questions, with overflow wrong', () => {
    const held = rows().flatMap(row => [
      { ...row, p: 0.5, teacherGood: row.good, projectionDigest: 'one' },
      { ...row, p: 0.5, teacherGood: row.good, projectionDigest: 'one' },
      { ...row, p: 0.5, teacherGood: row.good, projectionDigest: 'two' },
      row,
    ]);
    const result = planEscalation(rows(), held, { between: [0.4, 0.6] }, { maxCallsPerTrial: 1 });
    expect(result.heldOutAccuracy).toBe(0.75);
    expect(result.coverage).toBe(1);
    expect(planEscalation(rows(), held, { between: [0.4, 0.6] }, { maxCallsPerTrial: 2 }).heldOutAccuracy).toBe(1);
    const calls = rows().map(row => ({ outputId: row.outputId!, projectionDigest: 'other-question' }));
    expect(planEscalation(rows(), held, { between: [0.4, 0.6] }, { maxCallsPerTrial: 1, calls }).heldOutAccuracy).toBe(0.25);
    held.forEach(row => { row.outputId = undefined; row.projectionDigest = undefined; });
    expect(planEscalation(rows(), held, { between: [0.4, 0.6] }, { maxCallsPerTrial: 1 }).heldOutAccuracy).toBe(0.25);
  });
  it('enforces gate false-pass point and Wilson upper bounds', () => {
    const held = rows().map((row, index) => ({ ...row, good: index >= 5, p: index < 5 ? 0.1 : 0.9 }));
    const result = planEscalation(rows(), held, { between: [0.4, 0.6] }, { gate: true });
    expect(result.falsePassRate).toBe(0);
    expect(result.status).toBe('escalation-infeasible');
    expect(result.failures).toContain('gate.falsePass90Upper <= 0.20');
    held[0]!.p = 0.9;
    expect(planEscalation(rows(), held, { between: [0.4, 0.6] }, { gate: true }).failures).toContain('gate.falsePassRate <= 0.10');
    expect(planEscalation(rows(), rows(), { between: [0.4, 0.6] }, { gate: true }).status).toBe('calibrated');
    expect(planEscalation(rows(), rows().map(row => ({ ...row, good: true })), { between: [0.4, 0.6] }, { gate: true }).falsePassInterval).toEqual([0, 1]);
  });
  it('counts missing local decisions wrong and never treats them as retained groups or teacher calls', () => {
    const held = rows().map((row, index) => ({ ...row, missing: index < 10, p: index < 10 ? NaN : row.p,
      teacherGood: row.good }));
    const result = planEscalation(rows(), held, { target_accuracy: 1 });
    expect(result).toMatchObject({ heldOutAccuracy: 0.75, coverage: 0.75,
      independentGroups: 40, escalationRate: 0, status: 'escalation-infeasible' });
    expect(planEscalation(held.map(row => ({ ...row, missing: true })), held, { target_accuracy: 1 }).band).toBeUndefined();
  });
  it('simulates forced teacher requests even with missing local scores or no feasible band', () => {
    const held = rows().map(row => ({ ...row, missing: true, teacherGood: row.good }));
    expect(planEscalation([], held, { target_accuracy: 1 }, { forceTeacher: true, maxCallsPerTrial: 1 }))
      .toMatchObject({ heldOutAccuracy: 1, escalationRate: 1, coverage: 0 });
    const earlier = held.map(row => ({ outputId: row.outputId!, projectionDigest: 'earlier' }));
    expect(planEscalation([], held, { target_accuracy: 1 }, { forceTeacher: true, maxCallsPerTrial: 1, calls: earlier }).heldOutAccuracy).toBe(0);
  });
  it('rejects invalid configuration and probabilities', () => {
    for (const between of [[0.5, 0.5], [-1, 0.5], [0, 1.1], [0, NaN]] as const) {
      expect(() => planEscalation([], [], { between })).toThrow('between');
    }
    for (const target_accuracy of [0.5, 1.1, NaN]) expect(() => planEscalation([], [], { target_accuracy })).toThrow('target_accuracy');
    for (const maxCallsPerTrial of [0, -1, 1.5, Infinity]) {
      expect(() => planEscalation([], [], { target_accuracy: 1 }, { maxCallsPerTrial })).toThrow('maxCallsPerTrial');
    }
    expect(() => planEscalation([{ ...rows()[0]!, p: NaN }], [], { target_accuracy: 1 })).toThrow('p:');
  });
});

it('uses all held-out groups for coverage even without independent truth', () => {
  const held = rows(100).map((row, index) => ({ ...row,
    source: index < 15 ? 'human' as const : 'consensus' as const,
    p: index < 10 ? row.p : 0.5, teacherGood: row.good,
  }));
  expect(planEscalation(rows(), held, { between: [0.4, 0.6] })).toMatchObject({
    independentGroups: 15, heldOutAccuracy: 1, coverage: 0.1, status: 'escalation-infeasible',
    failures: ['heldOut.retainedCoverage >= 0.30'],
  });
  held.forEach((row, index) => { row.p = index < 15 ? 0.5 : row.good ? 0.9 : 0.1; });
  // The independently answerable subset has zero retention, but total retention is valid.
  expect(planEscalation(rows(), held, { between: [0.4, 0.6] })).toMatchObject({
    independentGroups: 15, heldOutAccuracy: 1, coverage: 0.85, status: 'calibrated',
  });
});

it('excludes disputed fit rows from band choice while retaining disputed held-out truth', () => {
  const fit = rows().map(row => ({ ...row, disputed: true, p: 0.9, good: true }));
  expect(planEscalation(fit, rows(), { target_accuracy: 0.9 }).band).toBeUndefined();
  expect(planEscalation(rows(), modelRows().map(row => ({ ...row, disputed: true })),
    { target_accuracy: 0.9 }, { teacherId: 'teacher' })).toMatchObject({
    independentGroups: 40, heldOutAccuracy: 0, status: 'escalation-infeasible',
  });
});

it('waives only coverage for forced teachers, preserving point, Wilson and independence bars', () => {
  const held = rows(20).map(row => ({ ...row, teacherGood: row.good, missing: true }));
  const plan = (sample = held, target_accuracy = 0.8) => planEscalation([], sample,
    { target_accuracy }, { forceTeacher: true, teacherId: 'teacher' });
  expect(plan()).toMatchObject({ status: 'calibrated', heldOutAccuracy: 1, coverage: 0, failures: [] });
  expect(plan(held, 1).failures).toEqual(['heldOut.cascade90Lower >= target_accuracy - 0.10']);
  expect(plan(held.slice(0, 14)).status).toBe('unverified');
  expect(plan(held.map(row => ({ ...row, teacherGood: !row.good }))).failures)
    .toContain('heldOut.cascadeAccuracy >= target_accuracy');
});
