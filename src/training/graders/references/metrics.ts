import { averageAnswers } from './policy.js';
import type { CouncilOutput, TrapAssessment } from './types.js';

export function adjudicationInstability(outputs: CouncilOutput[]) {
  const adjudicated = outputs.flatMap(output => Object.values(output.checks)).filter(check => check.adjudication.length > 0);
  const unstable = adjudicated.filter(check => check.adjudication.length !== 2 || check.adjudication[0]!.answer !== check.adjudication[1]!.answer).length;
  return { items: adjudicated.length, unstable, rate: adjudicated.length ? unstable / adjudicated.length : 0 };
}
function accuracy(rows: TrapAssessment[]) {
  const correct = rows.filter(row => row.actual !== null && (row.intended === 'unchanged' ?
    row.baseline !== undefined && row.baseline !== null && row.actual === row.baseline : row.actual === row.intended)).length;
  return { total: rows.length, correct, accuracy: rows.length ? correct / rows.length : null };
}
export function referenceQuality(outputs: CouncilOutput[], traps: TrapAssessment[]) {
  const overall = accuracy(traps);
  const grouped = (key: 'kind' | 'templateId') => Object.fromEntries([...new Set(traps.map(trap => trap[key]))].sort()
    .map(value => [value, accuracy(traps.filter(trap => trap[key] === value))]));
  const byKind = grouped('kind'), byTemplate = grouped('templateId');
  const instability = adjudicationInstability(outputs);
  const failures: string[] = [];
  if (overall.accuracy === null || overall.accuracy < 0.95) failures.push('trap accuracy must be >= 0.95 with nonempty validated traps');
  if (instability.rate > 0.05) failures.push('adjudication instability must be <= 0.05');
  const failingKinds = Object.entries(byKind).filter(([, score]) => score.accuracy! < 0.95).map(([kind]) => kind);
  const failingTemplates = Object.entries(byTemplate).filter(([, score]) => score.accuracy! < 0.95).map(([id]) => id);
  return { gate: failures.length ? 'STOP' as const : 'PASS' as const, failures, overall, byKind, byTemplate,
    failingKinds, failingTemplates, instability,
    optionPermutation: accuracy(traps.filter(trap => trap.kind === 'option-permutation')),
    teachers: leaveOneTeacherOut(outputs) };
}

/** Scores each teacher only against distributions from the other teachers. */
export function leaveOneTeacherOut(outputs: CouncilOutput[]) {
  const scores: Record<string, { items: number; agreement: number; softAgreement: number }> = {};
  for (const check of outputs.flatMap(output => Object.values(output.checks))) {
    for (const [id, answer] of Object.entries(check.teachers)) {
      const others = Object.entries(check.teachers).filter(([teacher]) => teacher !== id).map(([, vote]) => vote);
      if (!others.length) continue;
      const score = scores[id] ??= { items: 0, agreement: 0, softAgreement: 0 };
      const { distribution } = averageAnswers(Object.keys(check.distribution), others);
      const mass = distribution[answer.answer] ?? 0;
      score.items++; score.softAgreement += mass;
      // A strict majority of all peers is required, including missing/abstaining peers.
      if (mass > 0.5) score.agreement++;
    }
  }
  return Object.fromEntries(Object.entries(scores).map(([teacher, score]) => [teacher, {
    items: score.items, agreement: score.agreement / score.items, softAgreement: score.softAgreement / score.items,
  }]));
}
