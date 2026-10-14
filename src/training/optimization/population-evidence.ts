import { isDeepStrictEqual } from 'node:util';
import { sameComponents, type DspyResult, type DspyStart } from './protocol.js';
import type { CompletedEvaluation } from './host.js';

/** Check population lineage and deterministic selection independently of Python. */
export function verifyPopulationEvidence(result: DspyResult, start: DspyStart, completed: readonly CompletedEvaluation[]): void {
  const { provenance } = result;
  const search = start.search;
  if (!search || !provenance.rounds || !provenance.stopReason || !provenance.editScope) {
    throw new Error('Population provenance requires search, rounds, stop reason and edit scope');
  }
  if (provenance.changeEvidence !== 'bridge-reported-v2') throw new Error('Population change evidence must be labelled bridge-reported');
  const seedTrain = completed.slice(start.validationCaseIds.length, start.validationCaseIds.length + start.trainCaseIds.length);
  const seedTrainIds = new Set(seedTrain.map(row => row.caseId));
  if (seedTrain.length !== start.trainCaseIds.length || seedTrainIds.size !== start.trainCaseIds.length
      || start.trainCaseIds.some(id => !seedTrainIds.has(id))
      || seedTrain.some(row => row.split !== 'train' || !sameComponents(row.components, start.components))) {
    throw new Error('Population round 0 requires complete seed train evaluation');
  }
  for (const candidate of provenance.candidates.slice(1)) {
    const trained = completed.filter(row => row.split === 'train' && sameComponents(row.components, candidate.components));
    const ids = new Set(trained.map(row => row.caseId));
    if (trained.length !== start.trainCaseIds.length || ids.size !== start.trainCaseIds.length
        || start.trainCaseIds.some(id => !ids.has(id))) {
      throw new Error('Population candidate requires complete train evaluation');
    }
  }
  const expectedScope = start.editScope ?? Object.fromEntries(Object.keys(start.components).map(key => [key, 'whole-file']));
  if (!isDeepStrictEqual(provenance.editScope, expectedScope)) throw new Error('Population edit scope contradicts declared resources');
  const rounds = provenance.rounds;
  if (rounds.length < 1 || rounds.length > search.rounds + 1) throw new Error('Population round count exceeds declared search');
  let kept = [0];
  let stale = 0, best = provenance.candidates[0]!.validationScore, generationIndex = 0;
  const response = (): Record<string, unknown> => {
    const text = provenance.generations[generationIndex++]?.text;
    if (text === undefined) throw new Error('Population requires recorded generation responses');
    // Match the bridge's single whole JSON-fence envelope; never extract arbitrary JSON.
    const body: unknown = JSON.parse(text.trim().replace(/^```json\n([\s\S]*)\n```$/, '$1'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Population generation response is not an object');
    return body as Record<string, unknown>;
  };
  const discovered = new Set([0]);
  for (const [index, round] of rounds.entries()) {
    if (round.round !== index || !isDeepStrictEqual([...round.parents].sort((a, b) => a - b), index === 0 ? [] : [...kept].sort((a, b) => a - b))
        || (index === 0 ? round.variants.length !== 0 : round.variants.length !== search.variants)) {
      throw new Error('Population round parents or variant slots contradict search');
    }
    // Consume recorded responses in the bridge's parent-grouped execution order.
    const realized = new Map<number, Record<string, unknown>>();
    for (const parent of round.parents) {
      const slots = round.variants.filter(slot => slot.parent === parent);
      if (!slots.some(slot => slot.hypothesis)) continue;
      const planning = response();
      if (!Array.isArray(planning.hypotheses) || planning.hypotheses.length !== slots.length) {
        throw new Error('Population planning response contradicts slots');
      }
      for (const [ordinal, slot] of slots.entries()) {
        const plan = planning.hypotheses[ordinal] as Record<string, unknown> | null;
        if (!plan || plan.strategy !== slot.strategy || !isDeepStrictEqual(plan.targetedCriteria, slot.targetedCriteria)) {
          throw new Error('Population planning response contradicts strategy or criteria');
        }
        for (let attempt = 0; attempt < slot.attempts.length; attempt++) realized.set(slot.slot, response());
      }
    }
    const accepted: number[] = [];
    for (const [slotIndex, slot] of round.variants.entries()) {
      if (slot.slot !== slotIndex || slot.parent !== round.parents[slotIndex % round.parents.length]
          || slot.strategy !== (slotIndex < Math.ceil(search.variants * search.rewriteShare) ? 'rewrite' : 'refine')
          || slot.attempts.length > (start.proposal?.max_attempts ?? 2)) {
        throw new Error('Population variant slot contradicts declared parent or attempt bound');
      }
      const last = slot.attempts.at(-1);
      if (slot.status === 'empty' ? slot.attempts.length !== 0 || slot.rejectionReason !== 'budget'
        : !last || !slot.hypothesis.trim() || last.status !== slot.status || last.rejectionReason !== slot.rejectionReason
          || slot.attempts.slice(0, -1).some(attempt => attempt.status !== 'rejected' || !attempt.rejectionReason)) {
        throw new Error('Population slot status contradicts realization attempts or hypothesis');
      }
      if (slot.status !== 'accepted') {
        if (slot.candidateIndex !== null || !slot.rejectionReason) throw new Error('Population rejected slot claims evaluation or omits reason');
        continue;
      }
      const candidateIndex = slot.candidateIndex;
      const candidate = candidateIndex === null ? undefined : provenance.candidates[candidateIndex];
      if (candidateIndex === null || !candidate || discovered.has(candidateIndex)
          || !isDeepStrictEqual(candidate.parents, [slot.parent]) || slot.rejectionReason !== null) {
        throw new Error('Population accepted slot contradicts candidate lineage');
      }
      const realization = realized.get(slot.slot);
      if (!realization || !isDeepStrictEqual(realization.components, candidate.components)
          || realization.hypothesis !== slot.hypothesis || !Array.isArray(realization.expectedImpact)
          || !isDeepStrictEqual(realization.expectedImpact.map(item => item?.criterion).sort(), [...slot.targetedCriteria].sort())) {
        throw new Error('Population accepted candidate contradicts recorded realization response');
      }
      discovered.add(candidateIndex);
      accepted.push(candidateIndex);
    }
    const pool = [...kept, ...accepted];
    const byMean = (a: number, b: number) => provenance.candidates[b]!.validationScore - provenance.candidates[a]!.validationScore || a - b;
    const dominates = (a: number, b: number) => {
      const left = provenance.candidates[a]!.perCaseScores!, right = provenance.candidates[b]!.perCaseScores!;
      return start.validationCaseIds.every(id => left[id]! >= right[id]!)
        && start.validationCaseIds.some(id => left[id]! > right[id]!);
    };
    const frontier = search.selection === 'top-k' ? [] : pool.filter(b => !pool.some(a => a !== b && dominates(a, b)));
    const selected = [...frontier.sort(byMean), ...pool.filter(id => !frontier.includes(id)).sort(byMean)].slice(0, search.keep);
    if (!isDeepStrictEqual(round.kept, selected)) throw new Error('Population kept candidates contradict deterministic selection');
    kept = round.kept;
    if (index > 0) {
      const score = Math.max(...[...discovered].map(id => provenance.candidates[id]!.validationScore));
      stale = score === best ? stale + 1 : 0;
      best = score;
      if (index < rounds.length - 1 && (round.variants.some(slot => slot.status === 'empty')
          || stale >= (search.patience ?? search.rounds))) throw new Error('Population continued after its stop condition');
    }
  }
  if (generationIndex !== provenance.generations.length) throw new Error('Population rounds omit recorded generations');
  verifyStop(result, start, completed, kept, stale);
  if (discovered.size !== provenance.candidates.length) throw new Error('Population rounds omit evaluated candidates');
}

/** Budget feasibility is checked against observed train cache, not reported novelty. */
function verifyStop(result: DspyResult, start: DspyStart, completed: readonly CompletedEvaluation[], kept: number[], stale: number): void {
  const p = result.provenance, search = start.search!, rounds = p.rounds!;
  const count = rounds.length - 1;
  const empty = rounds.at(-1)!.variants.filter(slot => slot.status === 'empty');
  const trainCost = (index: number) => start.trainCaseIds.filter(caseId => !completed.some(row => row.split === 'train'
    && row.caseId === caseId && sameComponents(row.components, p.candidates[index]!.components))).length;
  const metricRemaining = start.budget.maxMetricCalls - p.evaluations;
  const proposalRemaining = start.budget.maxProposals - p.proposals;
  // The next shuffled parent is not recorded when no round starts. Require at
  // least one possible parent to be unfundable; do not claim RNG replay verification.
  const budgetBlocked = empty.length > 0
    ? empty.every(slot => proposalRemaining < (slot.hypothesis ? 1 : 2)
      || metricRemaining < start.validationCaseIds.length + start.trainCaseIds.length + trainCost(slot.parent))
    : kept.some(parent => proposalRemaining < 2 || metricRemaining < start.validationCaseIds.length + start.trainCaseIds.length + trainCost(parent));
  const patience = search.patience ?? search.rounds;
  const valid = p.stopReason === 'rounds' ? count === search.rounds && empty.length === 0
    : p.stopReason === 'patience' ? count > 0 && count < search.rounds && stale >= patience && empty.length === 0
    : p.stopReason === 'budget' && budgetBlocked && (empty.length > 0 || count < search.rounds && stale < patience);
  if (!valid) throw new Error('Population stop reason contradicts rounds, budget or patience');
}
