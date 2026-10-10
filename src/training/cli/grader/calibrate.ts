import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { allQuestions, applyPlatt, calibrateQuestions, calibrationMetrics, createCalibrationIdentity,
  evidenceFailures, expectedOptions, inEscalationBand, loadGrader, loadLabels, parseCalibration,
  planEscalation, splitCalibration, teacherAgreement, type CalibrationFile, type CalibrationRecord,
  type CascadeRecord, type BandPlan } from '../../graders/index.js';
import { validateStoredVotes } from '../../graders/labeling/index.js';
import { DECISION_PROMPT_VERSION } from '../../inference/decision/index.js';
import { backendIdentity, graderBackend, type GraderDependencies } from './backend.js';
import { estimateEscalationCost, type EscalationCostCall } from './cost.js';
import { cachedScores } from './cache.js';
import { excludeLabels, readExclusions } from './exclusions.js';
import { goldenInstances, rawGood, calibrationRecord, cascadeRecord } from './records.js';
import { calibrationReport, type QuestionDiagnostics } from './report.js';

export interface CalibrateOptions {
  graderFile: string; excludeDatasets?: string[]; seed?: string; reportFile?: string;
  concurrency?: number; signal?: AbortSignal;
}

export async function runCalibrate(options: CalibrateOptions, dependencies: GraderDependencies = {}): Promise<{
  calibrationFile: string; reportFile: string; calibration: CalibrationFile; code: 0 | 1;
}> {
  const grader = await loadGrader(options.graderFile);
  const loaded = await loadLabels(grader.golden, grader);
  validateStoredVotes(grader, loaded.labels, { resolved: true });
  const exclusions = await readExclusions(options.excludeDatasets ?? []);
  const labels = { ...loaded.labels, labels: excludeLabels(loaded.labels.labels, exclusions.ids) };
  const seed = options.seed ?? '0';
  const backend = graderBackend(grader, dependencies);
  options.signal?.throwIfAborted();
  const identity = await backendIdentity(grader, backend);
  const golden = goldenInstances(grader, labels);
  const results = await cachedScores(dirname(options.graderFile), backend, identity,
    golden.rows.map(row => row.request), options.concurrency ?? 2, options.signal);
  const valid = golden.rows.map((row, index) => {
    const raw = rawGood(row, results[index]!);
    return { row, record: { ...calibrationRecord(row, raw ?? 0), ...(raw === undefined ? { missing: true } : {}) } };
  });
  const records = valid.map(item => item.record);
  const split = splitCalibration(records, seed);
  const gates = grader.gates.map(gate => gate.id);
  const fitted = grader.model.backend === 'teacher' ? [] : calibrateQuestions(records, { seed, gates });
  const questions: CalibrationFile['questions'] = {};
  const diagnostics: Record<string, QuestionDiagnostics> = {};
  const cascades = new Map<CalibrationRecord, CascadeRecord>();
  for (const item of valid) {
    const fit = fitted.find(fit => fit.questionId === item.record.questionId);
    const p = fit && !item.record.missing ? applyPlatt(item.record.rawPGood, fit.params) : item.record.rawPGood;
    const cascade = cascadeRecord(item.row, item.record, p, labels.labelers);
    const vote = item.row.label.votes[item.row.instance.key]?.[grader.escalate.to];
    if (vote !== undefined && vote !== 'abstain') cascade.teacherGood = expectedOptions(item.row.question).includes(vote);
    cascades.set(item.record, cascade);
  }
  const plans = new Map<string, BandPlan>();
  let costCalls: EscalationCostCall[] = [];
  const plan = (id: string, calls?: { outputId: string; projectionDigest: string }[]) => planEscalation(
    split.fit.filter(row => row.questionId === id).map(row => cascades.get(row)!),
    split.heldOut.filter(row => row.questionId === id).map(row => cascades.get(row)!), grader.escalate,
    { teacherId: grader.escalate.to, maxCallsPerTrial: grader.escalate.max_calls_per_trial, gate: gates.includes(id), calls });
  if (grader.model.backend !== 'teacher') {
    for (const question of allQuestions(grader)) plans.set(question.id, plan(question.id));
    // Preserve output/instance expansion order; the same projection consumes only one call across questions.
    const heldOut = new Set(split.heldOut);
    const calls = valid.filter(({ record }) => {
      const band = plans.get(record.questionId)?.band;
      return !record.missing && heldOut.has(record) && band && inEscalationBand(cascades.get(record)!.p, band);
    }).map(({ row }) => ({ outputId: row.label.id, projectionDigest: row.instance.projectionDigest, instanceKeys: [row.instance.key] }));
    costCalls = calls;
    for (const question of allQuestions(grader)) plans.set(question.id, plan(question.id, calls));
  }
  for (const question of allQuestions(grader)) {
    const id = question.id, sample = golden.rows.filter(row => row.question.id === id);
    const indices = golden.rows.flatMap((row, index) => row.question.id === id ? [index] : []);
    diagnostics[id] = { missingRate: sample.length ? indices.filter(i => results[i]!.status === 'missing').length / sample.length : 0,
      boundedRate: sample.length ? indices.filter(i => results[i]!.bounded).length / sample.length : 0,
      sourceMix: { human: 0, consensus: 0, 'single-teacher': 0 } };
    for (const row of sample) diagnostics[id]!.sourceMix[row.golden.source]++;
    if (grader.model.backend === 'teacher') {
      // Keep missing backend answers in agreement denominator; split all golden instances.
      const allRecords = golden.rows.map(row => calibrationRecord(row, 0));
      const teacherSplit = splitCalibration(allRecords, seed);
      const held = new Set(teacherSplit.heldOut);
      const teacherId = grader.model.teacher;
      const agreementRows = golden.rows.flatMap((row, index) => {
        if (row.question.id !== id || !held.has(allRecords[index]!)) return [];
        const result = results[index]!;
        const answer = result.status === 'ok' ? row.request.optionLabels.find(option => result.probabilities?.[String(option)] === 1) : undefined;
        return [{ source: row.golden.source, group: row.label.lineage, good: expectedOptions(row.question).includes(row.golden.answer!),
          goldenAnswer: row.golden.answer!, teacherAnswer: answer,
          goldenLabelers: Object.keys(row.golden.votes).filter(name => name !== teacherId) }];
      });
      const agreement = teacherAgreement(agreementRows, teacherId);
      diagnostics[id]!.sourceAgreement = Object.fromEntries(['human', 'consensus', 'single-teacher'].map(source => {
        const subset = agreementRows.filter(row => row.source === source);
        const measured = teacherAgreement(subset, teacherId);
        return [source, { instances: measured.instances, agreement: measured.agreement }];
      }));
      questions[id] = { status: agreement.status, failures: agreement.failures, metrics: {
        groups: agreement.groups, instances: agreement.instances, good: agreement.good, bad: agreement.bad,
        baseRate: agreement.instances ? agreement.good / agreement.instances : 0, agreement: agreement.agreement,
      } };
      continue;
    }
    const fit = fitted.find(fit => fit.questionId === id);
    if (!fit) {
      const metrics = calibrationMetrics([], 0, seed, gates.includes(id));
      questions[id] = { status: 'insufficient-evidence', failures: evidenceFailures(metrics), metrics };
      continue;
    }
    const escalation = plans.get(id)!;
    questions[id] = { status: fit.status === 'calibrated' ? escalation.status : fit.status,
      failures: [...fit.failures, ...escalation.failures], params: fit.params,
      ...(escalation.band ? { band: [...escalation.band] } : {}), metrics: { ...fit.metrics,
        cascadeAccuracy: escalation.heldOutAccuracy, cascadeInterval: escalation.cascadeInterval, escalationRate: escalation.escalationRate, coverage: escalation.coverage } };
    diagnostics[id]!.bySource = fit.bySource;
    // A fixed sample observes positional sensitivity, without selecting or modifying the prompt.
    if (grader.model.backend === 'ollama-logprobs') {
      const chosen = indices.slice(0, 16);
      const reversed = await cachedScores(dirname(options.graderFile), backend, identity,
        chosen.map(index => ({ ...golden.rows[index]!.request, optionLabels: [...golden.rows[index]!.request.optionLabels].reverse() })),
        options.concurrency ?? 2, options.signal);
      let compared = 0, flips = 0;
      reversed.forEach((result, index) => {
        const original = rawGood(golden.rows[chosen[index]!]!, results[chosen[index]!]!);
        const reverse = rawGood(golden.rows[chosen[index]!]!, result);
        if (original !== undefined && reverse !== undefined) { compared++; if ((original >= 0.5) !== (reverse >= 0.5)) flips++; }
      });
      diagnostics[id]!.permutation = { compared, missing: chosen.length - compared, flipRate: compared ? flips / compared : null };
    }
  }
  if (await backendIdentity(grader, backend) !== identity) throw new Error('Backend identity changed during calibration');
  const calibration = parseCalibration({ schema: 'paideia.grader-calibration.v1', questions,
    identity: createCalibrationIdentity(grader, { backendModel: identity, golden: loaded.goldenDigest,
      promptTemplateVersion: DECISION_PROMPT_VERSION, seed, exclusions: exclusions.identities }) });
  const reportFile = options.reportFile ?? `${grader.calibration}.md`;
  options.signal?.throwIfAborted();
  await mkdir(dirname(grader.calibration), { recursive: true });
  const temporary = `${grader.calibration}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(calibration, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, grader.calibration);
  await mkdir(dirname(reportFile), { recursive: true });
  const cost = estimateEscalationCost(costCalls, labels, grader.escalate.to, grader.escalate.max_calls_per_trial);
  await writeFile(reportFile, calibrationReport(calibration, diagnostics, { excluded: loaded.labels.labels.length - labels.labels.length,
    disputed: golden.disputed, unavailable: golden.unavailable }) + `\nEscalation cost estimate (per represented escalated output; null = unknown):\n\n\`\`\`json\n${JSON.stringify(cost, null, 2)}\n\`\`\`\n`, { mode: 0o600 });
  return { calibrationFile: grader.calibration, reportFile, calibration,
    code: Object.values(questions).every(question => question.status === 'calibrated') ? 0 : 1 };
}
