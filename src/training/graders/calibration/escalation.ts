import { planCallAdmission, escalationCallKey as callKey, type EscalationCall } from '../admission.js';
export type { EscalationCall } from '../admission.js';
import { deriveConsensus } from '../consensus.js';
import type { Labels, Option } from '../format/index.js';
import { wilson90 } from './metrics.js';
import type { Interval, ScoredRecord } from './types.js';

export type EscalationBand = readonly [number, number];
export type BandPolicy = { between: EscalationBand } | { target_accuracy: number };
export interface CascadeRecord extends ScoredRecord {
  teacherGood?: boolean;
  goldenLabelers?: readonly string[];
  votes?: Record<string, Option>;
  asked?: readonly string[];
  labelers?: Labels['labelers'];
  expected?: readonly Option[];
  outputId?: string;
  projectionDigest?: string;
}
export interface EscalationTeacherReport {
  agreement: number;
  instances: number;
  source: 'human' | 'independent';
  warnings: string[];
}
export interface BandPlan {
  status: 'calibrated' | 'escalation-infeasible' | 'unverified';
  band?: EscalationBand;
  fitAccuracy: number;
  heldOutAccuracy: number;
  cascadeInterval: Interval;
  falsePassRate?: number;
  falsePassInterval?: Interval;
  independentGroups: number;
  escalationRate: number;
  coverage: number;
  failures: string[];
  teacherReport?: EscalationTeacherReport;
}

export function inEscalationBand(p: number, band: EscalationBand): boolean { return p >= band[0] && p <= band[1]; }

/** Retained group means a lineage with at least one retained (non-escalated) instance. */
function retainedCoverage(rows: readonly CascadeRecord[], band: EscalationBand): number {
  const total = new Set(rows.map(row => row.group)).size;
  return total ? new Set(rows.filter(row => !row.missing && !inEscalationBand(row.p, band)).map(row => row.group)).size / total : 0;
}

function retainedAccuracy(rows: readonly CascadeRecord[], band: EscalationBand): number {
  const retained = rows.filter(row => !row.missing && !inEscalationBand(row.p, band));
  return retained.length ? retained.filter(row => (row.p >= 0.5) === row.good).length / retained.length : 0;
}

/** Remove the escalation teacher before deriving strict option consensus, never binary majority. */
function independentGood(row: CascadeRecord, teacherId?: string): boolean | undefined {
  if (row.votes && row.labelers && row.expected && teacherId !== undefined) {
    const votes = Object.fromEntries(Object.entries(row.votes).filter(([name]) => name !== teacherId));
    const asked = [...row.asked ?? Object.keys(row.votes)].filter(name => name !== teacherId);
    const label = { id: 'cascade', lineage: row.group, output: null, context: {}, votes: { answer: votes }, asked, provenance: {} };
    const answer = deriveConsensus(label, row.labelers).answer!.answer;
    return answer === undefined ? undefined : row.expected.includes(answer);
  }
  // Human truth is independent; unidentified or model-derived truth requires original votes.
  return row.source === 'human' ? row.good : undefined;
}

function teacherAnswer(row: CascadeRecord, teacherId?: string): boolean | undefined {
  if (row.votes && row.expected && teacherId !== undefined) {
    const answer = row.votes[teacherId];
    return answer === undefined || answer === 'abstain' ? undefined : row.expected.includes(answer);
  }
  return row.teacherGood;
}

export function escalationTeacherReport(heldOut: readonly CascadeRecord[], teacherId: string): EscalationTeacherReport {
  const independent = heldOut.filter(row => independentGood(row, teacherId) !== undefined);
  const human = independent.filter(row => row.source === 'human');
  const sample = human.length ? human : independent;
  return { instances: sample.length, source: human.length ? 'human' : 'independent',
    warnings: independent.length < heldOut.length ? ['Instances without independent golden answers are excluded from cascade verification.'] : [],
    agreement: sample.length ? sample.filter(row => teacherAnswer(row, teacherId) !== undefined && teacherAnswer(row, teacherId) === independentGood(row, teacherId)).length / sample.length : 0 };
}

function callFor(row: CascadeRecord): EscalationCall | undefined {
  return row.outputId !== undefined && row.projectionDigest !== undefined
    ? { outputId: row.outputId, projectionDigest: row.projectionDigest } : undefined;
}

export function planEscalation(fit: readonly CascadeRecord[], heldOut: readonly CascadeRecord[], policy: BandPolicy,
  options: { teacherId?: string; maxCallsPerTrial?: number; gate?: boolean; calls?: readonly EscalationCall[]; forceTeacher?: boolean } = {}): BandPlan {
  if ([...fit, ...heldOut].some(row => !row.missing && (!Number.isFinite(row.p) || row.p < 0 || row.p > 1))) {
    throw new Error('p: expected finite probability');
  }
  const limit = options.maxCallsPerTrial ?? Infinity;
  if (options.maxCallsPerTrial !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('maxCallsPerTrial: expected positive integer');
  }
  const report = options.teacherId === undefined ? {} : { teacherReport: escalationTeacherReport(heldOut, options.teacherId) };
  let band: EscalationBand | undefined;
  if ('between' in policy) {
    const [lo, hi] = policy.between;
    if (!(Number.isFinite(lo) && Number.isFinite(hi) && lo >= 0 && lo < hi && hi <= 1)) {
      throw new Error('between: expected 0 <= lo < hi <= 1');
    }
    band = policy.between;
  } else {
    const target = policy.target_accuracy;
    if (!(Number.isFinite(target) && target > 0.5 && target <= 1)) throw new Error('target_accuracy: expected (0.5, 1]');
    // Width-first traversal is deterministic; ties choose the lowest lower endpoint.
    for (let width = 1; width <= 20 && !band; width++) {
      for (let lower = 0; lower + width <= 20; lower++) {
        const candidate: EscalationBand = [lower / 20, (lower + width) / 20];
        if (retainedCoverage(fit, candidate) >= 0.30 && retainedAccuracy(fit, candidate) >= target) {
          band = candidate; break;
        }
      }
    }
  }
  if (!band && options.forceTeacher) band = [0, 1];
  if (!band) return { status: 'escalation-infeasible', fitAccuracy: 0, heldOutAccuracy: 0, cascadeInterval: [0, 1],
    independentGroups: 0, escalationRate: 0, coverage: 0, failures: ['fit.target_accuracy and retainedCoverage >= 0.30'], ...report };
  const chosen = band;
  const escalated = heldOut.filter(row => options.forceTeacher || !row.missing && inEscalationBand(row.p, chosen));
  const calls = options.calls ?? escalated.flatMap(row => { const call = callFor(row); return call ? [call] : []; });
  const allowed = new Set(planCallAdmission(calls, limit).filter(call => call.admitted).map(callKey));
  const independent = heldOut.flatMap(row => {
    const good = independentGood(row, options.teacherId);
    if (good === undefined) return [];
    const call = callFor(row);
    const permitted = limit === Infinity || (call !== undefined && allowed.has(callKey(call)));
    const answer = options.forceTeacher || !row.missing && inEscalationBand(row.p, chosen)
      ? (permitted ? teacherAnswer(row, options.teacherId) : undefined) : row.missing ? undefined : row.p >= 0.5;
    return [{ ...row, good, answer }];
  });
  const independentGroups = new Set(independent.map(row => row.group)).size;
  const correct = independent.filter(row => row.answer !== undefined && row.answer === row.good).length;
  const heldOutAccuracy = independent.length ? correct / independent.length : 0;
  const cascadeInterval = wilson90(correct, independent.length);
  const coverage = options.forceTeacher ? 0 : retainedCoverage(independent, chosen);
  const failures: string[] = [];
  if (independentGroups < 15) failures.push('heldOut.independentGroups >= 15');
  if ('target_accuracy' in policy) {
    if (heldOutAccuracy < policy.target_accuracy) failures.push('heldOut.cascadeAccuracy >= target_accuracy');
    if (cascadeInterval[0] < policy.target_accuracy - 0.10) failures.push('heldOut.cascade90Lower >= target_accuracy - 0.10');
  }
  if (coverage < 0.30) failures.push('heldOut.retainedCoverage >= 0.30');
  const bad = independent.filter(row => !row.good);
  const falsePassCount = bad.filter(row => row.answer === true).length;
  const falsePassRate = bad.length ? falsePassCount / bad.length : 0;
  const falsePassInterval = wilson90(falsePassCount, bad.length);
  if (options.gate) {
    if (falsePassRate > 0.10) failures.push('gate.falsePassRate <= 0.10');
    if (falsePassInterval[1] > 0.20) failures.push('gate.falsePass90Upper <= 0.20');
  }
  return { status: independentGroups < 15 ? 'unverified' : failures.length ? 'escalation-infeasible' : 'calibrated', band: chosen,
    fitAccuracy: retainedAccuracy(fit, chosen), heldOutAccuracy, cascadeInterval, independentGroups,
    ...(options.gate ? { falsePassRate, falsePassInterval } : {}),
    escalationRate: heldOut.length ? escalated.length / heldOut.length : 0, coverage, failures, ...report };
}
