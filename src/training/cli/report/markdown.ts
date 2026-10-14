import type { TrainingSummary } from './summary.js';

const cell = (value: unknown) => String(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
  .replace(/\|/gu, '&#124;').replace(/`/gu, '&#96;').replace(/[\r\n]+/gu, ' ');
const number = (value: number | null) => value === null ? 'unknown / not run' : value.toFixed(4);
const table = (head: string[], rows: unknown[][]) => [head, head.map(() => '---'), ...rows]
  .map(row => `| ${row.map(cell).join(' | ')} |`).join('\n');
const block = (text: string) => {
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/gu)].map(match => match[0].length + 1)));
  return `${fence}diff\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`;
};

export function renderTrainingMarkdown(summary: TrainingSummary, bundle: string, diffs: Readonly<Record<string, string>>): string {
  const labels = new Map(summary.candidates.map(value => [value.candidate.id, value.label]));
  const selected = labels.get(summary.selectedCandidateId)!;
  const lines = ['# Training report', '', `Invocation: ${cell(summary.id)}. Selected candidate: **${selected}**.`, '',
    `Frozen selection: ${cell(summary.selectedCandidateId)}. Baseline: ${cell(summary.baselineCandidateId)}.`, '',
    'Selection is recorded by the optimizer before sealed testing; this exporter does not select or regrade.', '',
    `Candidate files, manifests and patches: [local bundle](${bundle}/). Machine-readable companion: [REPORT.json](REPORT.json).`, '',
    '## Split scores', '', 'Means weight examples equally. Missing/incomplete measurements stay unknown; observed means are partial diagnostics.', '',
    table(['Candidate', 'Split', 'Complete mean', 'Observed mean', 'Coverage'], summary.candidates.flatMap(value =>
      (['train', 'validation', 'test'] as const).map(split => [value.label, split, number(value.splits[split].meanScore),
        number(value.splits[split].observedMean), `${value.splits[split].examples.filter(example => example.meanScore !== null).length}/${value.splits[split].examples.length}`]))), '',
    '## Rounds', '', 'Original native scores measured in each search round. Prior captures are shown separately; tests and later rescores never enter these rows.', '',
    `Search trials without round attribution: ${summary.unattributedSearchTrialIds.length}. Their final scores remain in the split table.`, '',
    table(['Round', 'Candidate', 'Train in round', 'Validation in round', 'Prior/current train', 'Prior/current validation'],
      summary.roundScores.flatMap(round => round.candidates.map(value => [round.round, value.label,
        number(value.train), number(value.validation), number(value.availableThroughRound.train.meanScore),
        number(value.availableThroughRound.validation.meanScore)]))), '',
    '## Per-example scores', '',
    table(['Candidate', 'Split', 'Example', 'Trial', 'Measurement', 'Round', 'Score', 'Status', 'Host ms', 'Fidelity'],
      summary.candidates.flatMap(value => (['train', 'validation', 'test'] as const).flatMap(split => value.splits[split].examples.flatMap(example =>
        example.measurements.length ? example.measurements.map(measurement => [value.label, split, example.id, measurement.trialId,
          measurement.evaluationId, split === 'test' ? 'post-selection' : measurement.round ?? 'not recorded', number(measurement.score), measurement.status, number(measurement.durationMs),
          `${measurement.fidelity.measurement}; ${measurement.fidelity.execution}; historical unverified; isolation ${measurement.fidelity.declaredIsolation ?? 'unknown'}`])
          : [[value.label, split, example.id, 'not run', 'none', 'not recorded', 'unknown', 'not run', 'unknown', 'unverified']])))), '',
    '## Failing checks', '', summary.failureSummary.length ? table(['Check', 'Verdict', 'Affected trials'],
      summary.failureSummary.map(value => [value.check, value.status, value.trials])) : 'No non-passing checks recorded.', '',
    ...summary.failingChecks.map(value => `- ${cell(labels.get(value.candidateId))}/${cell(value.exampleId)} (${value.split}), ${cell(value.check)}: ${value.status}. ${cell(value.reason)}`), '',
    '## Held-out comparison and uncertainty', '',
    table(['Example', 'Baseline', 'Selected', 'Selected − baseline'], summary.heldOut.pairs.map(value =>
      [value.exampleId, number(value.baselineScore), number(value.selectedScore), number(value.delta)])), '',
    `Paired examples: ${summary.heldOut.pairedExamples}. Mean difference: ${number(summary.heldOut.meanDelta)}.`, '',
    `Sample standard deviation: ${number(summary.heldOut.standardDeviation)}. Standard error: ${number(summary.heldOut.standardError)}.`, '',
    summary.heldOut.uncertainty, '', '## Durations, requests and costs', '',
    `Invocation host elapsed time: ${number(summary.durationMs)} ms. Per-trial times include preparation, execution, final evaluation and closure; parallel times are not summed as elapsed time.`, '',
    `Recorded judge requests: ${summary.requests.judge ?? 'unknown'}. Optimizer requests: ${summary.requests.optimizer ?? 'unknown'}. Subject model requests: unknown.`, '',
    summary.requests.basis, '', 'API-equivalent USD uses the recorded price catalog or usage-priced decision receipts. Admission estimates are separate; actual billed/subscription charges remain unknown.', '',
    ...(summary.costs ? [table(['Role', 'Route/name', 'Entries', 'API-equivalent USD', 'Known subtotal USD', 'Completeness'], summary.costs.groups.map(group =>
      [group.role, group.name, group.entryCount, group.apiEquivalentUsd ? `${group.apiEquivalentUsd.low}–${group.apiEquivalentUsd.high}` : 'unknown',
        `${group.knownSubtotalUsd.low}–${group.knownSubtotalUsd.high}`, group.completeness])), '',
      `Total API-equivalent USD: ${summary.costs.apiEquivalentUsd ? `${summary.costs.apiEquivalentUsd.low}–${summary.costs.apiEquivalentUsd.high}` : 'unknown'}. Known subtotal: ${summary.costs.knownSubtotalUsd.low}–${summary.costs.knownSubtotalUsd.high}. Usage coverage: ${summary.costs.usageCoverage}.`, '',
      ...summary.costs.warnings.map(warning => `- ${cell(warning)}`)] : ['No cost receipts supplied; costs and request counts are unknown.']), '',
    '## Fidelity', '', summary.fidelity, '',
    'Coverage declarations, unavailable-score reasons and individual cost entries are retained in REPORT.json.', '',
    '## Candidate diffs against baseline', ''];
  for (const value of summary.candidates) {
    lines.push(`### ${value.label}${value.selected ? ' (selected)' : ''}`, '',
      `Files: [candidate manifest](${bundle}/candidates/${value.label}/manifest.json). Patch: [baseline.diff](${bundle}/candidates/${value.label}/baseline.diff).`, '',
      diffs[value.label] ? block(diffs[value.label]!) : 'No changes from baseline.', '');
  }
  return `${lines.join('\n')}\n`;
}
