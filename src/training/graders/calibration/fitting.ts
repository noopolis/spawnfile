import { createHash } from 'node:crypto';
import { calibrationBars, calibrationMetrics } from './metrics.js';
import type { CalibrationRecord, Exclusions, PlattFit, PlattParams, QuestionCalibration } from './types.js';

/** Hash rank gives a balanced 50/50 group split, invariant to input row ordering. */
export function splitCalibration(records: readonly CalibrationRecord[], seed: string, exclusions: Exclusions = {}): {
  fit: CalibrationRecord[]; heldOut: CalibrationRecord[]; excluded: CalibrationRecord[];
} {
  const lineages = new Set(exclusions.lineages);
  const examples = new Set(exclusions.examples?.map(example => JSON.stringify([example.dataset, example.id])));
  // Excluding an example excludes all revisions in its lineage, including revisions without example metadata.
  for (const record of records) {
    if (record.example && examples.has(JSON.stringify([record.example.dataset, record.example.id]))) lineages.add(record.group);
  }
  const excluded = records.filter(record => lineages.has(record.group));
  const eligible = records.filter(record => !lineages.has(record.group));
  const groups = [...new Set(eligible.map(record => record.group))].map(group => ({ group,
    hash: createHash('sha256').update(JSON.stringify([seed, group])).digest('hex'),
  })).sort((a, b) => a.hash.localeCompare(b.hash) || a.group.localeCompare(b.group));
  const fitGroups = new Set(groups.slice(0, Math.floor(groups.length / 2)).map(item => item.group));
  return { fit: eligible.filter(record => fitGroups.has(record.group)),
    heldOut: eligible.filter(record => !fitGroups.has(record.group)), excluded };
}

function logit(p: number): number {
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error('rawPGood: expected finite probability in [0, 1]');
  const clipped = Math.max(1e-6, Math.min(1 - 1e-6, p));
  return Math.log(clipped / (1 - clipped));
}

function sigmoid(value: number): number { return 1 / (1 + Math.exp(-value)); }

export function applyPlatt(rawPGood: number, params: PlattParams): number {
  if (!Number.isFinite(params.a) || !Number.isFinite(params.b)) throw new Error('params: expected finite a and b');
  return sigmoid(params.a * logit(rawPGood) + params.b);
}

/** Mean binary NLL + lambda * ((a-1)^2 + b^2), lambda=0.01.
 * This fixed regularizer is intentionally not weakened by larger instance counts.
 */
export function fitPlatt(records: readonly Pick<CalibrationRecord, 'rawPGood' | 'good'>[],
  options: { maxIterations?: number; tolerance?: number } = {}): PlattFit {
  const maxIterations = options.maxIterations ?? 100;
  const tolerance = options.tolerance ?? 1e-9;
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || !Number.isFinite(tolerance) || tolerance <= 0) {
    throw new Error('fit options: maxIterations must be positive integer and tolerance positive finite');
  }
  const rows = records.map(record => ({ x: logit(record.rawPGood), y: Number(record.good) }));
  let a = 1, b = 0;
  if (!rows.length) return { a, b, converged: false, iterations: 0 };
  const loss = (nextA: number, nextB: number): number => rows.reduce((sum, row) => {
    const z = nextA * row.x + nextB;
    return sum + Math.max(z, 0) + Math.log1p(Math.exp(-Math.abs(z))) - row.y * z;
  }, 0) / rows.length + 0.01 * ((nextA - 1) ** 2 + nextB ** 2);
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    let ga = 0.02 * (a - 1), gb = 0.02 * b, aa = 0.02, ab = 0, bb = 0.02;
    for (const row of rows) {
      const p = sigmoid(a * row.x + b), residual = (p - row.y) / rows.length;
      const curvature = p * (1 - p) / rows.length;
      ga += residual * row.x; gb += residual;
      aa += curvature * row.x * row.x; ab += curvature * row.x; bb += curvature;
    }
    if (Math.hypot(ga, gb) < tolerance) return { a, b, converged: true, iterations: iteration };
    const determinant = aa * bb - ab * ab;
    const da = (bb * ga - ab * gb) / determinant, db = (aa * gb - ab * ga) / determinant;
    let step = 1;
    const currentLoss = loss(a, b);
    // Summed NLL has O(n * epsilon) roundoff; do not stall a converged Newton step on that noise.
    const roundoff = Number.EPSILON * rows.length * Math.max(1, currentLoss);
    while (step > 1e-8 && loss(a - step * da, b - step * db) > currentLoss + roundoff) step /= 2;
    a -= step * da; b -= step * db;
  }
  return { a, b, converged: false, iterations: maxIterations };
}

export function calibrateQuestions(records: readonly CalibrationRecord[], options: {
  seed: string; exclusions?: Exclusions; gates?: readonly string[];
}): QuestionCalibration[] {
  const population = splitCalibration(records, options.seed, options.exclusions);
  const split = { fit: population.fit.filter(record => !record.disputed),
    heldOut: population.heldOut.filter(record => !record.disputed) };
  return [...new Set(records.map(record => record.questionId))].map(questionId => {
    const question = records.find(record => record.questionId === questionId)!;
    if (records.some(record => record.questionId === questionId && record.type !== question.type)) {
      throw new Error(`${questionId}.type: inconsistent question types`);
    }
    const questionSplit = split.fit.filter(record => record.questionId === questionId);
    const questionFit = questionSplit.filter(record => !record.missing);
    const fitGroups = new Set(questionFit.map(record => record.group)).size;
    const fitSource = fitGroups >= 20 ? 'question' : 'type';
    const fit = fitSource === 'question' ? questionFit : split.fit.filter(record => record.type === question.type && !record.missing);
    const params = fitPlatt(fit);
    const baseRate = questionSplit.length ? questionSplit.filter(record => record.good).length / questionSplit.length : 0;
    const heldOut = split.heldOut.filter(record => record.questionId === questionId)
      .map(record => ({ ...record, p: record.missing ? 0 : applyPlatt(record.rawPGood, params) }));
    const gate = options.gates?.includes(questionId) ?? false;
    const metrics = calibrationMetrics(heldOut, baseRate, `${options.seed}:${questionId}`, gate);
    const bars = calibrationBars(metrics);
    if (!params.converged) { bars.status = 'insufficient-evidence'; bars.failures.push('fit.convergence'); }
    if (!questionFit.length) { bars.status = 'insufficient-evidence'; bars.failures.push('fit.questionInstances > 0'); }
    const bySource: QuestionCalibration['bySource'] = {};
    for (const source of ['human', 'editor', 'consensus', 'single-teacher'] as const) {
      const subset = heldOut.filter(record => record.source === source);
      if (subset.length) bySource[source] = calibrationMetrics(subset, baseRate, `${options.seed}:${questionId}:${source}`, gate);
    }
    return { questionId, params: { a: params.a, b: params.b }, fitSource, fitGroups, metrics, bySource, ...bars,
      interpretation: heldOut.some(record => record.source === 'human')
        ? 'human-adjudicated and teacher agreement' : heldOut.some(record => record.source === 'editor')
          ? 'editor-adjudicated and teacher agreement' : 'teacher agreement, not validated correctness' };
  });
}
