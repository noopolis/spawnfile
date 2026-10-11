import type { DecisionAccounting } from '../../contracts/grading.js';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { summarizeDecisionAccounting, allQuestions, applyPlatt, calibrateQuestions, calibrationMetrics, createCalibrationIdentity,
  decisionModels, graderForModel, selectQuestionModel, stableDigest, evidenceFailures, expectedOptions, inEscalationBand, loadGrader, loadLabels, parseCalibration,
  planEscalation, splitCalibration, teacherAgreement, type CalibrationFile, type CalibrationRecord,
  type CascadeRecord, type BandPlan } from '../../graders/index.js';
import { validateStoredVotes } from '../../graders/labeling/index.js';
import { DECISION_PROMPT_VERSION } from '../../inference/decision/index.js';
import { backendIdentity, graderBackend, withDecisionBudget, type GraderDependencies } from './backend.js';
import { estimateEscalationCost, type EscalationCostCall } from './cost.js';
import { cachedScores } from './cache.js';
import { excludeLabels, readExclusions } from './exclusions.js';
import { goldenInstances, indexDecisionResults, rawGood, calibrationRecord, cascadeRecord } from './records.js';
import { calibrationReport, type QuestionDiagnostics } from './report.js';

export interface CalibrateOptions {
  graderFile: string; excludeDatasets?: string[]; seed?: string; reportFile?: string;
  concurrency?: number; signal?: AbortSignal; maxSpendUsd?: number;
}

export async function runCalibrate(options: CalibrateOptions, dependencies: GraderDependencies = {}): Promise<{
  calibrationFile: string; reportFile: string; calibration: CalibrationFile; code: 0 | 1; decisionAccounting?: DecisionAccounting;
}> {
  const grader = await loadGrader(options.graderFile);
  dependencies = withDecisionBudget(grader, { ...dependencies, maxSpendUsd: options.maxSpendUsd ?? dependencies.maxSpendUsd });
  const loaded = await loadLabels(grader.golden, grader);
  validateStoredVotes(grader, loaded.labels, { resolved: true });
  const exclusions = await readExclusions(options.excludeDatasets ?? []);
  const labels = { ...loaded.labels, labels: excludeLabels(loaded.labels.labels, exclusions) };
  const seed = options.seed ?? '0';
  const gates = grader.gates.map(gate => gate.id);
  const models = decisionModels(grader);
  const commonGolden = goldenInstances(grader, labels);
  // Candidates share device capacity: finish one backend before starting the next.
  // Each still owns its identity, cache and worker bound, in authored order.
  const scoreCandidate = async (model: (typeof models)[number]) => {
    const definition = graderForModel(grader, model);
    try {
      options.signal?.throwIfAborted();
      const backend = graderBackend(definition, dependencies);
      const identity = await backendIdentity(definition, backend, options.signal);
      const golden = goldenInstances(definition, labels);
      const results = await cachedScores(dirname(options.graderFile), backend, stableDigest({ model: model.id, identity }),
        golden.rows.map(row => row.request), options.concurrency ?? 2, options.signal);
      indexDecisionResults(golden.rows.map(row => row.request), results);
      const valid = golden.rows.map((row, index) => {
        const raw = rawGood(row, results[index]!);
        return { row, record: { ...calibrationRecord(row, raw ?? 0), ...(raw === undefined ? { missing: true } : {}) } };
      });
      const records = valid.map(item => item.record);
      const split = splitCalibration(records, seed);
      // Selection shares the full-panel denominator. Teacher-only independent
      // disputes are charged missing, never removed to improve a candidate's loss.
      const selectionRecords = commonGolden.rows.map((row, index) => ({
        ...calibrationRecord(row, valid[index]!.record.rawPGood),
        ...(valid[index]!.record.missing || valid[index]!.record.disputed ? { missing: true } : {}),
      }));
      return { model, definition, backend, identity, golden, results, valid, split,
        selection: { id: model.id, teacher: model.backend === 'teacher', fit: splitCalibration(selectionRecords, seed).fit },
        fitted: model.backend === 'teacher' ? [] : calibrateQuestions(records, { seed, gates }) };
    } catch (cause) { throw new Error(`Decision model ${model.id}: ${cause instanceof Error ? cause.message : 'calibration failed'}`, { cause }); }
  };
  const candidates: Awaited<ReturnType<typeof scoreCandidate>>[] = [];
  for (const model of models) candidates.push(await scoreCandidate(model));
  const selected = new Map(allQuestions(grader).map(question => {
    const id = selectQuestionModel(question.id, question.type, candidates.map(candidate => candidate.selection));
    return [question.id, candidates.find(candidate => candidate.model.id === id)!];
  }));
  const valid = commonGolden.rows.map((row, index) => selected.get(row.question.id)!.valid[index]!);
  const golden = { ...commonGolden, rows: valid.map(item => item.row) };
  const observations = golden.rows.map(row => ({ ...row, outputId: row.label.id }));
  const results = golden.rows.map((row, index) => selected.get(row.question.id)!.results[index]!);
  const byKey = indexDecisionResults(observations.map(row => row.request), results);
  const records = valid.map(item => item.record);
  const split = splitCalibration(records, seed);
  const fitted = allQuestions(grader).flatMap(question => selected.get(question.id)!.fitted.filter(fit => fit.questionId === question.id));
  const localQuestions = allQuestions(grader).filter(question => selected.get(question.id)!.model.backend !== 'teacher');
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
  const forced = new Set<string>();
  const plan = (id: string, calls?: { outputId: string; projectionDigest: string }[]) => planEscalation(
    split.fit.filter(row => row.questionId === id).map(row => cascades.get(row)!),
    split.heldOut.filter(row => row.questionId === id).map(row => cascades.get(row)!), grader.escalate,
    { teacherId: grader.escalate.to, maxCallsPerTrial: grader.escalate.max_calls_per_trial, gate: gates.includes(id), calls, forceTeacher: forced.has(id) });
  if (localQuestions.length) {
    for (const question of localQuestions) plans.set(question.id, plan(question.id));
    const heldOutputs = new Set(valid.filter(item => split.heldOut.includes(item.record)).map(item => item.row.label.id));
    const failedPlans = new Map<string, BandPlan>();
    // A newly failing cascade becomes forced-teacher and can consume earlier calls.
    // The set only grows, so at most one round per question is needed to settle routing.
    for (let round = 0; round <= plans.size; round++) {
      const before = forced.size;
      if (grader.uncalibrated === 'teacher') {
        for (const [id, candidate] of plans) {
          if (fitted.find(fit => fit.questionId === id)?.status !== 'calibrated' || candidate.status !== 'calibrated') {
            forced.add(id);
            if (!failedPlans.has(id)) failedPlans.set(id, candidate);
          }
        }
      }
      const calls = observations.filter(row => {
        if (!heldOutputs.has(row.outputId)) return false;
        if (forced.has(row.question.id)) return true;
        const band = plans.get(row.question.id)?.band;
        const raw = rawGood(row, byKey.get(row.request.key)!);
        const fit = fitted.find(fit => fit.questionId === row.question.id);
        return raw !== undefined && band && fit && inEscalationBand(applyPlatt(raw, fit.params), band);
      }).map(row => ({ outputId: row.outputId, projectionDigest: row.instance.projectionDigest, instanceKeys: [row.instance.key] }));
      costCalls = calls;
      for (const question of localQuestions) {
        const updated = plan(question.id, calls), failure = failedPlans.get(question.id);
        plans.set(question.id, failure ? { ...updated, status: failure.status === 'calibrated' ? updated.status : failure.status,
          failures: [...updated.failures, ...(failure.status === 'calibrated' ? [] : ['local cascade requires forced-teacher routing'])] } : updated);
      }
      if (grader.uncalibrated !== 'teacher' || before === forced.size &&
        [...plans].every(([id, candidate]) => forced.has(id) || candidate.status === 'calibrated')) break;
    }
  }
  for (const question of allQuestions(grader)) {
    const candidate = selected.get(question.id)!;
    const { model, backend, identity } = candidate;
    const id = question.id, sample = golden.rows.filter(row => row.question.id === id && !row.golden.disputed);
    const indices = golden.rows.flatMap((row, index) => row.question.id === id && !row.golden.disputed ? [index] : []);
    diagnostics[id] = { candidates: candidates.map(candidate => ({ id: candidate.model.id,
      ece: candidate.fitted.find(fit => fit.questionId === id)?.metrics.ece ?? null,
      brier: candidate.fitted.find(fit => fit.questionId === id)?.metrics.brier ?? null })), missingRate: sample.length ? indices.filter(i => results[i]!.status === 'missing').length / sample.length : 0,
      boundedRate: sample.length ? indices.filter(i => results[i]!.bounded).length / sample.length : 0,
      sourceMix: { human: 0, editor: 0, consensus: 0, 'single-teacher': 0 } };
    for (const row of sample) diagnostics[id]!.sourceMix[row.golden.source]++;
    if (model.backend === 'teacher') {
      // Teacher-only scoring uses the same pre-dispute held-out population.
      const held = new Set(split.heldOut);
      const teacherId = model.teacher;
      const agreementRows = golden.rows.flatMap((row, index) => {
        if (row.question.id !== id || row.golden.disputed || !held.has(valid[index]!.record)) return [];
        const result = results[index]!;
        const answer = result.status === 'ok' ? row.request.optionLabels.find(option => result.probabilities?.[String(option)] === 1) : undefined;
        return [{ source: row.golden.source, group: row.label.lineage, good: expectedOptions(row.question).includes(row.golden.answer!),
          goldenAnswer: row.golden.answer!, teacherAnswer: answer,
          goldenLabelers: Object.keys(row.golden.votes).filter(name => name !== teacherId) }];
      });
      const agreement = teacherAgreement(agreementRows, teacherId);
      const heldCascade = valid.flatMap((item, index) => {
        if (item.record.questionId !== id || !held.has(item.record)) return [];
        const result = results[index]!;
        const answer = result.status === 'ok' ? item.row.request.optionLabels.find(option => result.probabilities?.[String(option)] === 1) : undefined;
        const cascade = cascades.get(item.record)!;
        return [{ ...cascade, votes: { ...cascade.votes, [teacherId]: answer ?? 'abstain' } }];
      });
      const escalation = planEscalation([], heldCascade, grader.escalate, { teacherId, forceTeacher: true, gate: gates.includes(id) });
      diagnostics[id]!.sourceAgreement = Object.fromEntries(['human', 'editor', 'consensus', 'single-teacher'].map(source => {
        const subset = agreementRows.filter(row => row.source === source);
        const measured = teacherAgreement(subset, teacherId);
        return [source, { instances: measured.instances, agreement: measured.agreement }];
      }));
      questions[id] = { model: model.id, status: agreement.status === 'calibrated' ? escalation.status : agreement.status,
        failures: [...agreement.failures, ...escalation.failures], teacherAccuracy: escalation.teacherReport, metrics: {
        cascadeAccuracy: escalation.heldOutAccuracy, cascadeInterval: escalation.cascadeInterval, coverage: escalation.coverage,
        groups: agreement.groups, instances: agreement.instances, good: agreement.good, bad: agreement.bad,
        baseRate: agreement.instances ? agreement.good / agreement.instances : 0, agreement: agreement.agreement,
      } };
      continue;
    }
    const fit = fitted.find(fit => fit.questionId === id);
    if (!fit) {
      const metrics = calibrationMetrics([], 0, seed, gates.includes(id));
      questions[id] = { model: model.id, status: 'insufficient-evidence', failures: evidenceFailures(metrics), metrics, teacherAccuracy: plans.get(id)!.teacherReport };
      continue;
    }
    const escalation = plans.get(id)!;
    questions[id] = { model: model.id, status: fit.status === 'calibrated' ? escalation.status : fit.status,
      failures: [...fit.failures, ...escalation.failures], params: fit.params, teacherAccuracy: escalation.teacherReport,
      ...(escalation.band ? { band: [...escalation.band] } : {}), metrics: { ...fit.metrics,
        cascadeAccuracy: escalation.heldOutAccuracy, cascadeInterval: escalation.cascadeInterval, escalationRate: escalation.escalationRate, coverage: escalation.coverage } };
    diagnostics[id]!.bySource = fit.bySource;
    // A fixed sample observes positional sensitivity, without selecting or modifying the prompt.
    if (model.backend === 'ollama-logprobs') {
      const chosen = indices.slice(0, 16);
      const reversed = await cachedScores(dirname(options.graderFile), backend, stableDigest({ model: model.id, identity }),
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
  for (const candidate of candidates) {
    if (await backendIdentity(candidate.definition, candidate.backend, options.signal) !== candidate.identity) {
      throw new Error(`Backend identity changed during calibration: ${candidate.model.id}`);
    }
  }
  const modelIdentities = Object.fromEntries(candidates.map(candidate => [candidate.model.id, candidate.identity]));
  const calibration = parseCalibration({ schema: 'paideia.grader-calibration.v1', questions,
    identity: createCalibrationIdentity(grader, { backendModel: grader.models ? stableDigest(modelIdentities) : candidates[0]!.identity,
      ...(grader.models ? { modelIdentities } : {}), golden: loaded.goldenDigest,
      promptTemplateVersion: DECISION_PROMPT_VERSION, seed, exclusions: exclusions.identities }) });
  const reportFile = options.reportFile ?? `${grader.calibration}.md`;
  options.signal?.throwIfAborted();
  await mkdir(dirname(grader.calibration), { recursive: true });
  const temporary = `${grader.calibration}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(calibration, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, grader.calibration);
  await mkdir(dirname(reportFile), { recursive: true });
  const receipts = candidates.flatMap(candidate => candidate.backend.requestReceipts?.() ?? []);
  const decisionAccounting = candidates.some(candidate => candidate.backend.capabilities?.billing === 'api')
    ? summarizeDecisionAccounting(receipts) : undefined;
  const missingReasons = candidates.flatMap(candidate => candidate.results.filter(result => result.status === 'missing')
    .map(result => ({ model: candidate.model.id, key: result.key, reason: result.reason ?? 'missing' })));
  const cost = estimateEscalationCost(costCalls, labels, grader.escalate.to, grader.escalate.max_calls_per_trial);
  await writeFile(reportFile, calibrationReport(calibration, diagnostics, { excluded: loaded.labels.labels.length - labels.labels.length,
    disputed: golden.disputed, unavailable: golden.unavailable }) + `\nEscalation cost estimate (per represented escalated output; null = unknown):\n\n\`\`\`json\n${JSON.stringify({ escalation: cost, decisionAccounting, missingDecisions: missingReasons }, null, 2)}\n\`\`\`\n`, { mode: 0o600 });
  return { calibrationFile: grader.calibration, reportFile, calibration, decisionAccounting,
    code: Object.values(questions).every(question => question.status === 'calibrated') ? 0 : 1 };
}
