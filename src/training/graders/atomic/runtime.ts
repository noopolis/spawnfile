import type { DecisionResult, DecisionRequestReceipt } from '../../contracts/grading.js';
import { stableDigest } from '../format/index.js';
import { instantiateChecksReport, locateUnit, validateDecomposition } from '../decomposition/index.js';
import type { CheckInstance, DecompositionInputs } from '../decomposition/index.js';
import { aggregateAtomic } from './aggregate.js';
import { atomicFeedback } from './feedback.js';
import type { AtomicRuntime, AtomicCheckScore, AtomicGradeResult, AtomicExtraction } from './types.js';

function probability(check: CheckInstance, decision?: DecisionResult): number | null {
  if (!decision || decision.key !== check.id || decision.status !== 'ok' || !decision.probabilities) return null;
  const values = check.options.map(option => decision.probabilities![option]!);
  if (values.some(value => value === undefined || !Number.isFinite(value) || value < 0 || value > 1) ||
    Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 1e-6) return null;
  return check.expected.reduce((sum, option) => sum + decision.probabilities![option]!, 0);
}

/** All extraction and paid transport are injected; this module owns executable scoring semantics. */
export async function gradeAtomic(runtime: AtomicRuntime, inputs: DecompositionInputs, signal?: AbortSignal): Promise<AtomicGradeResult> {
  signal?.throwIfAborted();
  inputs = { ...inputs, obligationKinds: runtime.grader.aggregation.obligation_kinds };
  const receipts: DecisionRequestReceipt[] = [];
  let extraction: AtomicExtraction = { receipts: [], judgeCalls: [] };
  const scores: AtomicCheckScore[] = [];
  let failed = false;
  let failure: AtomicGradeResult['failure'];
  try {
    const identity = await runtime.backend.identity(signal, receipts);
    if (identity.backend !== 'typesafe' || identity.model !== runtime.grader.decision.model) throw new Error('Atomic decision identity mismatch');
    extraction = await runtime.extract(inputs, signal);
    if (extraction.error || !extraction.decomposition) throw new Error('Atomic extraction incomplete');
    const document = extraction.decomposition;
    if (!document.audit) throw new Error('Atomic omission audit missing');
    const validation = validateDecomposition(document, inputs, runtime.templates);
    const report = instantiateChecksReport(runtime.templates, document, inputs);
    const units = [...document.units, ...document.audit.missed, ...(document.rejected ?? []).map(item => item.unit)];
    for (const check of report.checks) {
      const unit = units.find(unit => unit.id === check.unit_id)!;
      const template = runtime.templates.templates.find(template => template.id === check.template_id);
      const location = locateUnit(unit, inputs, runtime.templates);
      scores.push({ check, occurrence: typeof location === 'string' ? unit.id : stableDigest({ location, pair: unit.pair }), unit: unit.text, kind: unit.kind, dimension: template?.dimension ?? Object.keys(runtime.grader.aggregation.dimensions)[0]!,
      severity: template?.severity ?? 'critical', probability: null });
    }
    // Absent families remain missing; validated applicability exclusions do not invent failures.
    for (const template of runtime.templates.templates) {
      if (report.checks.some(check => check.template_id === template.id)) continue;
      if (report.skipped.some(skip => skip.template_id === template.id)) continue;
      const check: CheckInstance = { id: `${template.id}@missing`, template_id: template.id, unit_id: `missing-${template.id}`,
        type: template.type, instructions: template.instructions, criteria: template.criteria, options: Object.keys(template.criteria),
        expected: template.expected, projection: {}, digest: stableDigest(template), status: 'missing', reasons: ['No applicable units extracted'] };
      scores.push({ check, occurrence: check.unit_id, unit: '', kind: template.applies_to, dimension: template.dimension, severity: template.severity, probability: null });
    }
    // Rejected spans remain missing measurements rather than infrastructure failures.
    if (validation.rejected.length) for (const score of scores) {
      if (validation.rejected.some(unit => unit.id === score.check.unit_id)) score.check.status = 'missing';
    }
    const ready = scores.filter(score => score.check.status === 'ready');
    const decisions = ready.length ? await runtime.backend.score(ready.map(({ check }) => ({ key: check.id,
      type: check.type, optionLabels: check.options, expectedOptions: check.expected,
      instructions: `${check.instructions}\nCriteria: ${JSON.stringify(check.criteria)}`, projection: check.projection })), signal, receipts) : [];
    if (decisions.some(decision => decision.status === 'missing' && decision.failureCause === 'spend-cap')) {
      failure = { cause: 'spend-cap', reason: 'spend cap' };
    }
    for (const score of ready) {
      const matches = decisions.filter(decision => decision.key === score.check.id);
      if (matches.length === 1) {
        const decision = matches[0]!;
        score.decision = { key: decision.key, status: decision.status,
          ...(decision.reason === undefined ? {} : { reason: decision.reason }),
          ...(decision.failureCause ? { failureCause: decision.failureCause } : {}) };
      }
      score.probability = matches.length === 1 ? probability(score.check, matches[0]) : null;
    }
  } catch { failed = true; }
  const aggregate = aggregateAtomic(runtime.grader, scores);
  const missing = scores.some(score => score.probability === null);
  const status = failed || failure ? 'error' : missing ? runtime.grader.missing : aggregate.criticalGate === 1 && aggregate.score >= runtime.grader.aggregation.pass_at ? 'pass' : 'fail';
  return { schema: 'paideia.atomic-grade.v1', status, ...aggregate,
    ...(failure ? { failure, score: null } : {}),
    identity: { definitionDigest: runtime.definitionDigest, templatesDigest: runtime.templatesDigest,
      outputDigest: stableDigest(inputs.output), contextDigest: stableDigest(inputs.context) },
    checks: scores, extraction, receipts, feedback: atomicFeedback(scores, runtime.grader.feedback), judgeCalls: extraction.judgeCalls };
}
