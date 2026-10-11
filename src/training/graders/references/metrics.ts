import { averageAnswers } from './policy.js';
import type { CouncilOutput, TrapAssessment } from './types.js';

/** Callers pass the frozen base population; duplicate serialized checks count once. */
export function adjudicationInstability(outputs: CouncilOutput[], variant = false) {
  const unique = new Map<string, CouncilOutput['checks'][string]>();
  for (const output of outputs) for (const [id, check] of Object.entries(output.checks)) {
    const key = JSON.stringify([variant ? check.digest : output.outputDigest, id]);
    const previous = unique.get(key);
    // Conflicting copies must not replace an unstable observation with a stable one.
    if (!previous || unstable(check) || (!unstable(previous) && previous.adjudication.length === 0)) unique.set(key, check);
  }
  const adjudicated = [...unique.values()].filter(check => check.ready !== false);
  const count = adjudicated.filter(unstable).length;
  return { items: adjudicated.length, unstable: count, rate: adjudicated.length ? count / adjudicated.length : 0 };
}
function unstable(check: CouncilOutput['checks'][string]): boolean {
  return check.status === 'uncertain' || check.adjudication.some(vote => vote.answer === null) || check.adjudication.length > 0 && (check.adjudication.length !== 2 || check.adjudication[0]!.answer !== check.adjudication[1]!.answer);
}
/** Every unique instantiated base check participates, including rejected units. */
function baseCompleteness(outputs: CouncilOutput[], outputIds: string[]) {
  const unique = new Map<string, { outputId: string; templateId: string; missing: boolean }>();
  for (const [index, output] of outputs.entries()) for (const [id, check] of Object.entries(output.checks)) {
    const key = JSON.stringify([output.outputDigest, id]);
    const missing = check.ready === false || check.final === null;
    if (!unique.has(key) || missing) unique.set(key, {
      outputId: outputIds[index] ?? output.outputDigest, templateId: check.template_id, missing,
    });
  }
  const rows = [...unique.values()];
  const count = (items: typeof rows) => {
    const missing = items.filter(item => item.missing).length;
    return { total: items.length, missing, rate: items.length ? missing / items.length : 0 };
  };
  const group = (key: 'outputId' | 'templateId') => Object.fromEntries([...new Set(rows.map(row => row[key]))]
    .map(value => [value, count(rows.filter(row => row[key] === value))]));
  return { ...count(rows), byTemplate: group('templateId'), byOutput: group('outputId') };
}
function accuracy(rows: TrapAssessment[]) {
  const correct = rows.filter(row => row.actual !== null && (row.intended === 'unchanged' ?
    row.baseline !== undefined && row.baseline !== null && row.actual === row.baseline : row.baseline !== undefined && row.baseline !== null && row.actual !== row.baseline && row.actual === row.intended)).length;
  return { total: rows.length, correct, accuracy: rows.length ? correct / rows.length : null };
}
const controlKinds = new Set(['format-paraphrase', 'option-permutation']);
const defectKinds = new Set(['number-substitution', 'entity-substitution', 'negation-flip', 'citation-swap', 'injected-redundancy']);
export function referenceQuality(baseOutputs: CouncilOutput[], traps: TrapAssessment[],
  population: { outputIds: string[]; variantOutputs?: CouncilOutput[]; rejectedUnits?: number } = { outputIds: [] }) {
  const eligible = traps.filter(trap => trap.known_answer !== false);
  const diagnostic = traps.filter(trap => trap.known_answer === false);
  const known = eligible.filter(trap => defectKinds.has(trap.kind) && trap.intended !== 'unchanged');
  const controls = eligible.filter(trap => controlKinds.has(trap.kind) && trap.intended === 'unchanged');
  const knownAnswer = accuracy(known), consistency = accuracy(controls);
  const grouped = (rows: TrapAssessment[], key: 'kind' | 'templateId') => Object.fromEntries([...new Set(rows.map(trap => trap[key]))].sort()
    .map(value => [value, accuracy(rows.filter(trap => trap[key] === value))]));
  const byKind = grouped(known, 'kind'), byTemplate = grouped(known, 'templateId');
  const instability = adjudicationInstability(baseOutputs);
  const completeness = baseCompleteness(baseOutputs, population.outputIds);
  const outputIds = [...new Set(population.outputIds)];
  const uncovered = outputIds.filter(id => !known.some(trap => trap.outputId === id));
  const coverage = { missingChecks: population.rejectedUnits ?? 0, total: outputIds.length, covered: outputIds.length - uncovered.length, uncovered,
    uncoveredRate: outputIds.length ? uncovered.length / outputIds.length : 1 };
  const failures: string[] = [];
  if (knownAnswer.accuracy === null || knownAnswer.accuracy < 0.95) failures.push('known-answer accuracy must be >= 0.95 with nonempty validated defect traps');
  if (consistency.accuracy === null || consistency.accuracy < 0.95) failures.push('consistency must be >= 0.95 with nonempty validated controls');
  if (!coverage.total || coverage.uncovered.length) failures.push('every output must have a validated known-answer trap');
  if (coverage.missingChecks) failures.push('rejected units remain missing checks');
  if (completeness.missing) failures.push('missing base checks must be <= 0%');
  if (instability.rate > 0.05) failures.push('base adjudication instability must be <= 0.05');
  const failingKinds = Object.entries(byKind).filter(([, score]) => score.total >= 10 && score.accuracy! < 0.95).map(([kind]) => kind);
  const failingTemplates = Object.entries(byTemplate).filter(([, score]) => score.total >= 10 && score.accuracy! < 0.95).map(([id]) => id);
  failures.push(...failingKinds.map(kind => `known-answer kind ${kind} accuracy must be >= 0.95`),
    ...failingTemplates.map(id => `known-answer template ${id} accuracy must be >= 0.95`));
  const insufficientKinds = Object.entries(byKind).filter(([, score]) => score.total < 10).map(([id]) => id);
  const insufficientTemplates = Object.entries(byTemplate).filter(([, score]) => score.total < 10).map(([id]) => id);
  return { gate: failures.length ? 'STOP' as const : 'PASS' as const, failures, knownAnswer, consistency, coverage, completeness, byKind, byTemplate,
    diagnostic: accuracy(diagnostic), diagnosticByKind: grouped(diagnostic, 'kind'), diagnosticByTemplate: grouped(diagnostic, 'templateId'),
    consistencyByKind: grouped(controls, 'kind'), consistencyByTemplate: grouped(controls, 'templateId'),
    insufficientKinds, insufficientTemplates, failingKinds, failingTemplates, instability, variantAdjudication: adjudicationInstability(population.variantOutputs ?? [], true),
    optionPermutation: accuracy(controls.filter(trap => trap.kind === 'option-permutation')),
    teachers: leaveOneTeacherOut(baseOutputs) };
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
      const mass = answer.answer === null ? 0 : distribution[answer.answer] ?? 0;
      score.items++; score.softAgreement += mass;
      // A strict majority of all peers is required, including missing/abstaining peers.
      if (mass > 0.5) score.agreement++;
    }
  }
  return Object.fromEntries(Object.entries(scores).map(([teacher, score]) => [teacher, {
    items: score.items, agreement: score.agreement / score.items, softAgreement: score.softAgreement / score.items,
  }]));
}
