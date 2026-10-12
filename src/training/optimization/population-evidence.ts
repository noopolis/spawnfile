import { isDeepStrictEqual } from 'node:util';
import type { DspyResult, DspyStart } from './protocol.js';

/** Check population lineage and deterministic selection independently of Python. */
export function verifyPopulationEvidence(result: DspyResult, start: DspyStart): void {
  const { provenance } = result;
  const search = start.search;
  if (!search || !provenance.rounds || !provenance.stopReason || !provenance.editScope) {
    throw new Error('Population provenance requires search, rounds, stop reason and edit scope');
  }
  const expectedScope = start.editScope ?? Object.fromEntries(Object.keys(start.components).map(key => [key, 'whole-file']));
  if (!isDeepStrictEqual(provenance.editScope, expectedScope)) throw new Error('Population edit scope contradicts declared resources');
  const rounds = provenance.rounds;
  if (rounds.length < 1 || rounds.length > search.rounds + 1) throw new Error('Population round count exceeds declared search');
  let kept = [0];
  const discovered = new Set([0]);
  for (const [index, round] of rounds.entries()) {
    if (round.round !== index || !isDeepStrictEqual([...round.parents].sort((a, b) => a - b), index === 0 ? [] : [...kept].sort((a, b) => a - b))
        || (index === 0 ? round.variants.length !== 0 : round.variants.length !== search.variants)) {
      throw new Error('Population round parents or variant slots contradict search');
    }
    const accepted: number[] = [];
    for (const [slotIndex, slot] of round.variants.entries()) {
      if (slot.slot !== slotIndex || !kept.includes(slot.parent)
          || slot.attempts.length > (start.proposal?.max_attempts ?? 2)) {
        throw new Error('Population variant slot contradicts declared parent or attempt bound');
      }
      if (slot.status !== 'accepted') {
        if (slot.candidateIndex !== null || !slot.rejectionReason) throw new Error('Population rejected slot claims evaluation or omits reason');
        continue;
      }
      const candidateIndex = slot.candidateIndex;
      const candidate = candidateIndex === null ? undefined : provenance.candidates[candidateIndex];
      if (candidateIndex === null || !candidate || discovered.has(candidateIndex)
          || !isDeepStrictEqual(candidate.parents, [slot.parent]) || slot.rejectionReason !== null
          || slot.behavioralChange === null || slot.behavioralChange < search.minChange) {
        throw new Error('Population accepted slot contradicts candidate lineage or behavioral gate');
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
  }
  if (discovered.size !== provenance.candidates.length) throw new Error('Population rounds omit evaluated candidates');
}
