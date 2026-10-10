import type { ScoredRecord } from './types.js';

export type EscalationBand = readonly [number, number];
export type BandPolicy = { between: EscalationBand } | { target_accuracy: number };
export interface CascadeRecord extends ScoredRecord { teacherGood?: boolean; goldenLabelers?: readonly string[] }
export interface EscalationTeacherReport {
  agreement: number;
  instances: number;
  source: 'human' | 'all';
  warnings: string[];
}
export interface BandPlan {
  status: 'feasible' | 'escalation-infeasible';
  band?: EscalationBand;
  fitAccuracy: number;
  heldOutAccuracy: number;
  escalationRate: number;
  coverage: number;
  failures: string[];
  teacherReport?: EscalationTeacherReport;
}

export function inEscalationBand(p: number, band: EscalationBand): boolean { return p >= band[0] && p <= band[1]; }

/** Retained group means a lineage with at least one retained (non-escalated) instance. */
function retainedCoverage(rows: readonly CascadeRecord[], band: EscalationBand): number {
  const total = new Set(rows.map(row => row.group)).size;
  return total ? new Set(rows.filter(row => !inEscalationBand(row.p, band)).map(row => row.group)).size / total : 0;
}

function retainedAccuracy(rows: readonly CascadeRecord[], band: EscalationBand): number {
  const retained = rows.filter(row => !inEscalationBand(row.p, band));
  return retained.length ? retained.filter(row => (row.p >= 0.5) === row.good).length / retained.length : 0;
}

export function escalationTeacherReport(heldOut: readonly CascadeRecord[], teacherId: string): EscalationTeacherReport {
  const human = heldOut.filter(row => row.source === 'human');
  const sample = human.length ? human : heldOut;
  const warnings: string[] = [];
  if (heldOut.some(row => row.goldenLabelers?.includes(teacherId))) {
    warnings.push('Escalation teacher contributed golden labels; held-out agreement may be biased upward.');
  }
  if (heldOut.some(row => row.goldenLabelers === undefined)) warnings.push('Golden labeler identities are unobserved.');
  return { instances: sample.length, source: human.length ? 'human' : 'all', warnings,
    agreement: sample.length ? sample.filter(row => row.teacherGood !== undefined && row.teacherGood === row.good).length / sample.length : 0 };
}

export function planEscalation(fit: readonly CascadeRecord[], heldOut: readonly CascadeRecord[], policy: BandPolicy,
  options: { teacherId?: string } = {}): BandPlan {
  if ([...fit, ...heldOut].some(row => !Number.isFinite(row.p) || row.p < 0 || row.p > 1)) {
    throw new Error('p: expected finite probability');
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
  if (!band) return { status: 'escalation-infeasible', fitAccuracy: 0, heldOutAccuracy: 0,
    escalationRate: 0, coverage: 0, failures: ['fit.target_accuracy and retainedCoverage >= 0.30'], ...report };
  const chosen = band;
  const escalated = heldOut.filter(row => inEscalationBand(row.p, chosen));
  const correct = heldOut.filter(row => inEscalationBand(row.p, chosen)
    ? row.teacherGood !== undefined && row.teacherGood === row.good : (row.p >= 0.5) === row.good).length;
  const heldOutAccuracy = heldOut.length ? correct / heldOut.length : 0;
  const coverage = retainedCoverage(heldOut, chosen);
  const failures: string[] = [];
  if ('target_accuracy' in policy) {
    if (heldOutAccuracy < policy.target_accuracy - 0.03) failures.push('heldOut.cascadeAccuracy >= target_accuracy - 0.03');
    if (coverage < 0.30) failures.push('heldOut.retainedCoverage >= 0.30');
  }
  return { status: failures.length ? 'escalation-infeasible' : 'feasible', band: chosen,
    fitAccuracy: retainedAccuracy(fit, chosen), heldOutAccuracy,
    escalationRate: heldOut.length ? escalated.length / heldOut.length : 0, coverage, failures, ...report };
}
