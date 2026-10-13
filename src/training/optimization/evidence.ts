import { isDeepStrictEqual } from 'node:util';
import { sameComponents, type DspyResult } from './protocol.js';
import { verifyPopulationEvidence } from './population-evidence.js';
import type { DspyHost } from './host.js';

/** Trust recorded host callbacks, not optimizer-provided scores or counters alone. */
export async function verifyDspyResult(result: DspyResult, host: DspyHost, signal: AbortSignal): Promise<void> {
  const { start, completed, generations } = host;
  const { provenance } = result;
  if (result.id !== start.id || provenance.seed !== start.seed
      || provenance.evaluations !== host.evaluations || provenance.proposals !== host.proposals
      || provenance.candidates.length > host.proposals + 1 || host.pending !== 0) {
    throw new Error('DSPy terminal identity, counters or candidate count do not match host evidence');
  }
  const captures = completed.map(({ caseId, split, result: evaluated }) => ({ caseId, split, captureId: evaluated.captureId }));
  // Checkpoint JSON canonicalizes object keys; array order and every value remain authoritative.
  const ordered = (rows: typeof captures) => [...rows].sort((a, b) => a.captureId.localeCompare(b.captureId));
  if (!isDeepStrictEqual(ordered(captures), ordered(provenance.captures))
      || !isDeepStrictEqual(generations.map(({ model, usage, modelBasis, text }) => ({ model, usage,
        ...(modelBasis === undefined ? {} : { modelBasis }), ...(start.search ? { text } : {}) })), provenance.generations)) {
    throw new Error('DSPy terminal capture or inference provenance does not match host evidence');
  }
  if ((provenance.optimizer === 'paideia.population') !== Boolean(start.search)) {
    throw new Error('DSPy optimizer mode contradicts requested search');
  }
  const validation = completed.filter((entry) => entry.split === 'validation');
  const size = start.validationCaseIds.length;
  if (validation.length !== size * provenance.candidates.length) throw new Error('DSPy omitted complete candidate validation');
  let best = 0;
  for (const [index, candidate] of provenance.candidates.entries()) {
    await host.validate(candidate.components, signal);
    if (index === 0 && (!sameComponents(candidate.components, start.components)
        || candidate.parents.length !== 1 || candidate.parents[0] !== null)) throw new Error('DSPy altered the baseline identity');
    if (index > 0 && (candidate.parents.length !== 1 || candidate.parents.some((parent) => parent === null || parent >= index))) {
      throw new Error('DSPy candidate lineage does not reference an earlier parent');
    }
    if (candidate.discoveryEvaluations > host.evaluations
        || (index === 0 && candidate.discoveryEvaluations !== 0)
        || (index > 0 && candidate.discoveryEvaluations <= provenance.candidates[index - 1]!.discoveryEvaluations)) {
      throw new Error('DSPy candidate discovery contradicts observed evaluation ordering');
    }
    const batch = validation.slice(index * size, (index + 1) * size);
    const ids = new Set(batch.map((entry) => entry.caseId));
    if (ids.size !== size || start.validationCaseIds.some((id) => !ids.has(id))
        || batch.some((entry) => !sameComponents(entry.components, candidate.components))) {
      throw new Error('DSPy candidate lacks the declared native validation captures');
    }
    const score = batch.reduce((sum, entry) => sum + entry.result.score, 0) / size;
    if (start.search && !isDeepStrictEqual(candidate.perCaseScores,
      Object.fromEntries(batch.map(entry => [entry.caseId, entry.result.score])))) {
      throw new Error('Population per-case scores contradict native evaluations');
    }
    if (Math.abs(score - candidate.validationScore) > 1e-10) throw new Error('DSPy candidate score contradicts native evaluations');
    if (candidate.validationScore > provenance.candidates[best]!.validationScore) best = index;
  }
  if (start.search) verifyPopulationEvidence(result, start, completed);
  if (provenance.selectedCandidateIndex !== best
      || !sameComponents(result.components, provenance.candidates[best]!.components)) {
    throw new Error('DSPy selected components contradict validation selection');
  }
}
