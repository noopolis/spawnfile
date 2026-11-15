import type { CheckNode } from '../contracts/dataset.js';
import type { EvaluationContext, EvaluationResult, JudgeCall } from '../contracts/evaluation.js';
import { parseBank, runQuestionnaire } from '../questionnaire/index.js';
import { result } from './logic/index.js';
import { judgeFailure } from './semantic/failure.js';
import { observedAbsence, selectEvidence, textReference } from './selectors.js';

/** Every judge call of a run shares the routes; checks on them never overlap. */
export function questionnaireResources(context: EvaluationContext): readonly object[] {
  return Object.values(context.judges).map(route => route.provider);
}

/**
 * The questionnaire check: the bank's groups asked in order on the run's named judge routes. Its score is
 * the whole bank's, open and hidden; its status is the bank's gate. A judge that could not answer a gate
 * question is an `error` with a named cause, never a pass and never a silent zero.
 */
export async function evaluateQuestionnaire(check: CheckNode, context: EvaluationContext): Promise<EvaluationResult> {
  const input = check.input as string;
  const selected = selectEvidence(input, context.snapshot);
  if (!selected.found) {
    if (observedAbsence(input, context.snapshot)) {
      return { ...result('fail', `Graded artifact ${input} is missing from a completed, fully accounted subject execution`), score: 0, evidence: selected.evidence };
    }
    return { ...result('unknown', 'Graded artifact was not observed', context.snapshot.closed), evidence: selected.evidence };
  }
  const source = await context.readText(check.bank as string);
  const bank = parseBank(source);
  const evidence = [...selected.evidence, textReference('sidecar', check.bank as string, source)];
  const bound: Record<string, unknown> = {};
  for (const [name, selector] of Object.entries((check.context ?? {}) as Record<string, string>)) {
    const selection = selectEvidence(selector, context.snapshot);
    if (!selection.found) return { ...result('unknown', `Questionnaire context ${name} was not observed`, context.snapshot.closed), evidence };
    bound[name] = selection.value;
    evidence.push(...selection.evidence);
  }
  const graded = await runQuestionnaire({ bank, material: { output: selected.value, context: bound }, judges: context.judges, signal: context.signal,
    observe: async attempt => { await context.observeJudgeAttempt?.(attempt); } });
  const usage = graded.judgeCalls.flatMap((call: JudgeCall) => call.usage ? [call.usage] : []);
  const base = { score: graded.score ?? 0, questionnaire: graded, evidence, judgeCalls: graded.judgeCalls, ...(usage.length ? { usage } : {}) };
  const summary = `Questionnaire ${bank.id}: gate ${graded.gate}`;
  if (graded.gate === 'error') {
    const failed = graded.failedCalls[0];
    const call = graded.judgeCalls.findLast(entry => entry.outcome !== 'completed');
    const judge = bank.groups.find(group => group.id === failed?.group)?.judge ?? bank.groups[0]!.judge;
    return { ...result('error', `${summary}; ${failed?.reason ?? `answers outside the declared type: ${graded.errors.join(', ')}`}`, context.snapshot.closed), ...base,
      judgeFailure: judgeFailure(!failed ? 'response-schema' : !call ? 'route-unusable' : call.outcome === 'generation-error' ? 'provider-error' : 'response-unparseable',
        { judge, requestedModel: call?.requestedModel ?? null, call }) };
  }
  // The reason is optimizer-visible, so it carries the gate only; per-question detail goes through the open projection.
  return { ...result(graded.gate, summary, context.snapshot.closed), ...base };
}
