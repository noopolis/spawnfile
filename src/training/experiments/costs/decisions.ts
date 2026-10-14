import { isDeepStrictEqual } from 'node:util';
import type { EvaluationResult, PlanEvaluation } from '../../contracts/evaluation.js';
import type { DecisionRequestReceipt } from '../../contracts/grading.js';
import type { TrialReport } from '../trials/index.js';
import type { RescoreReport } from '../replay/index.js';
import type { CostEntry } from './report.js';

/** Originating request identity survives check aliases and selective measurement repair. */
export function decisionCostEntries(trials: readonly TrialReport[], rescores: readonly RescoreReport[] = []): CostEntry[] {
  const receipts = new Map<string, { trialId: string; versions: DecisionRequestReceipt[] }>();
  const visit = (value: EvaluationResult, measurement: string, trialId: string, path: string, plan?: PlanEvaluation) => {
    const canonical = value.id && plan?.checks[value.id] ? `check/${value.id}` : path;
    [...value.decisionAccounting?.receipts ?? [], ...value.grading?.decisionAccounting?.receipts ?? []].forEach((receipt, index) => {
      const id = receipt.requestId === undefined
        ? JSON.stringify(['decision', measurement, canonical, index]) // Legacy captures have no origin identity.
        : JSON.stringify(['decision', receipt.requestId]);
      const entry = receipts.get(id) ?? { trialId, versions: [] };
      if (!entry.versions.some(version => isDeepStrictEqual(version, receipt))) entry.versions.push(receipt);
      receipts.set(id, entry);
    });
    value.children?.forEach((child, index) => visit(child, measurement, trialId, `${canonical}/children/${index}`, plan));
  };
  const plan = (evaluation: PlanEvaluation, id: string, trialId: string) => {
    Object.entries(evaluation.checks).forEach(([key, value]) => visit(value, id, trialId, `check/${key}`, evaluation));
    evaluation.stages.forEach(stage => {
      stage.checks.forEach((value, index) => visit(value, id, trialId, `stage/${stage.id}/check/${index}`, evaluation));
      visit(stage.gate, id, trialId, `check/${stage.id}`, evaluation);
    });
  };
  for (const trial of trials) {
    plan(trial.evaluation, trial.id, trial.id);
    trial.turns.forEach(turn => turn.checks.forEach((value, index) => visit(value, trial.id, trial.id, `turn/${turn.id}/${index}`)));
    trial.live.forEach((value, index) => visit(value.result, trial.id, trial.id, `live/${index}`));
    // Decisive failures reference a live result; do not bill that reference again.
    if (trial.decisiveFailure && !trial.live.some(value => JSON.stringify(value.result) === JSON.stringify(trial.decisiveFailure))) {
      visit(trial.decisiveFailure, trial.id, trial.id, 'decisiveFailure');
    }
  }
  rescores.forEach(rescore => plan(rescore.evaluation, rescore.id, rescore.runId));
  return [...receipts].map(([id, { trialId, versions }]) => {
    const receipt = versions[0]!;
    const known = versions.length === 1 && receipt.usd !== null && Number.isFinite(receipt.usd) && receipt.usd >= 0;
    return { id, trialId, role: 'judge', name: `decision/${receipt.model}`, model: receipt.model,
      modelBasis: 'requested-assumption', responseRoute: receipt.endpoint, outcome: String(receipt.status ?? 'unknown'), usage: null,
      decisionReceipt: receipt, ...(versions.length > 1 ? { decisionReceiptVersions: versions } : {}),
      valuation: { status: known ? 'priced' : 'incomplete', price: null,
        apiEquivalentUsd: known ? { low: receipt.usd!, high: receipt.usd! } : null,
        assumptions: [versions.length > 1 ? 'Conflicting representations of one decision receipt; cost cannot be selected.'
          : 'Recorded usage-priced API decision cost; admission estimates are not spend or invoice evidence.'] } };
  });
}
