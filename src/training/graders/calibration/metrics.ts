import { createHash } from 'node:crypto';
import type { BarResult, CalibrationMetrics, EvidenceCounts, Interval, ScoredRecord } from './types.js';

export function seededRandom(seed: string): () => number {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function evidenceCounts(records: readonly Pick<ScoredRecord, 'group' | 'good'>[]): EvidenceCounts {
  const good = records.filter(record => record.good).length;
  return { groups: new Set(records.map(record => record.group)).size, instances: records.length,
    good, bad: records.length - good };
}

/** Equal-mass bins; fewer than 10 instances cannot form a valid ECE bin. */
export function expectedCalibrationError(records: readonly Pick<ScoredRecord, 'p' | 'good'>[]): number {
  if (records.length < 10) return 1;
  const sorted = [...records].sort((a, b) => a.p - b.p);
  const bins = Math.min(10, Math.floor(sorted.length / 10));
  let total = 0;
  for (let index = 0; index < bins; index++) {
    const bin = sorted.slice(Math.floor(index * sorted.length / bins), Math.floor((index + 1) * sorted.length / bins));
    total += Math.abs(bin.reduce((sum, row) => sum + row.p - Number(row.good), 0));
  }
  return total / records.length;
}

function brier(records: readonly Pick<ScoredRecord, 'p' | 'good'>[]): number {
  return records.length ? records.reduce((sum, row) => sum + (row.p - Number(row.good)) ** 2, 0) / records.length : 1;
}

function percentile(values: number[], fraction: number): number {
  values.sort((a, b) => a - b);
  const position = (values.length - 1) * fraction;
  const low = Math.floor(position), high = Math.ceil(position);
  return values[low]! + (values[high]! - values[low]!) * (position - low);
}

/** Every selected lineage contributes all its instances, including repeated draws. */
export function groupBootstrap(records: readonly ScoredRecord[], seed: string): {
  eceInterval: Interval; brierInterval: Interval;
} {
  if (!records.length) return { eceInterval: [1, 1], brierInterval: [1, 1] };
  const byGroup = new Map<string, ScoredRecord[]>();
  for (const record of records) {
    const group = byGroup.get(record.group) ?? [];
    group.push(record); byGroup.set(record.group, group);
  }
  const groups = [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, rows]) => rows);
  const random = seededRandom(seed), eces: number[] = [], briers: number[] = [];
  for (let iteration = 0; iteration < 1000; iteration++) {
    const sample: ScoredRecord[] = [];
    for (let draw = 0; draw < groups.length; draw++) sample.push(...groups[Math.floor(random() * groups.length)]!);
    eces.push(expectedCalibrationError(sample)); briers.push(brier(sample));
  }
  return { eceInterval: [percentile(eces, 0.05), percentile(eces, 0.95)],
    brierInterval: [percentile(briers, 0.05), percentile(briers, 0.95)] };
}

export function calibrationMetrics(records: readonly ScoredRecord[], baseRate: number, seed: string,
  gate = false): CalibrationMetrics {
  if (!Number.isFinite(baseRate) || baseRate < 0 || baseRate > 1) throw new Error('baseRate: expected probability');
  if (records.some(record => !Number.isFinite(record.p) || record.p < 0 || record.p > 1)) {
    throw new Error('p: expected finite probability');
  }
  const counts = evidenceCounts(records);
  return { ...counts, baseRate,
    accuracy: records.length ? records.filter(row => (row.p >= 0.5) === row.good).length / records.length : 0,
    brier: brier(records),
    baseRateBrier: brier(records.map(row => ({ ...row, p: baseRate }))),
    ece: expectedCalibrationError(records), ...groupBootstrap(records, seed),
    ...(gate ? { falsePassRate: counts.bad ? records.filter(row => row.p >= 0.5 && !row.good).length / counts.bad : 0 } : {}),
  };
}

export function evidenceFailures(counts: EvidenceCounts): string[] {
  const failures: string[] = [];
  if (counts.groups < 15) failures.push('evidence.groups >= 15');
  if (counts.instances < 30) failures.push('evidence.instances >= 30');
  if (counts.good < 5) failures.push('evidence.good >= 5');
  if (counts.bad < 5) failures.push('evidence.bad >= 5');
  return failures;
}

export function calibrationBars(metrics: CalibrationMetrics): BarResult {
  const evidence = evidenceFailures(metrics);
  if (evidence.length) return { status: 'insufficient-evidence', failures: evidence };
  const failures: string[] = [];
  if (!(metrics.ece <= 0.10)) failures.push('calibration.ece <= 0.10');
  if (!(metrics.eceInterval[1] <= 0.15)) failures.push('calibration.ece90Upper <= 0.15');
  if (!(metrics.brier <= 0.20)) failures.push('calibration.brier <= 0.20');
  if (!(metrics.brier < metrics.baseRateBrier)) failures.push('calibration.brier < baseRateBrier');
  if (metrics.falsePassRate !== undefined && !(metrics.falsePassRate <= 0.10)) failures.push('gate.falsePassRate <= 0.10');
  return { status: failures.length ? 'uncalibrated' : 'calibrated', failures };
}

export interface TeacherAgreementRecord {
  group: string;
  good: boolean;
  goldenAnswer: string | number;
  teacherAnswer?: string | number;
  /** Labeler identities contributing to the golden answer, excluding disputed labels. */
  goldenLabelers: readonly string[];
}

export function teacherAgreement(records: readonly TeacherAgreementRecord[], teacherId: string):
  BarResult & EvidenceCounts & { agreement: number; excludedSelfLabels: number } {
  // A consensus containing this teacher must be rederived from other labelers by the caller.
  const independent = records.filter(row => row.goldenLabelers.length > 0 && !row.goldenLabelers.includes(teacherId));
  const counts = evidenceCounts(independent);
  const agreement = independent.length
    ? independent.filter(row => row.teacherAnswer !== undefined && row.teacherAnswer === row.goldenAnswer).length / independent.length : 0;
  const failures = evidenceFailures(counts);
  const insufficient = failures.length > 0;
  if (agreement < 0.85) failures.push('teacher.agreement >= 0.85');
  return { ...counts, agreement, excludedSelfLabels: records.length - independent.length, failures,
    status: insufficient ? 'insufficient-evidence' : failures.length ? 'uncalibrated' : 'calibrated' };
}
