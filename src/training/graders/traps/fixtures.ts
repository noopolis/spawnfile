import { parseCheckTemplates, parseDecomposition, trapKinds } from '../decomposition/index.js';
import type { CheckTemplates, Decomposition, DecompositionInputs } from '../decomposition/index.js';

export function fixture(): { templates: CheckTemplates; document: Decomposition; inputs: DecompositionInputs } {
  const templates = parseCheckTemplates({ schema: 'paideia.check-templates.v1', context: {
    evidence: { rows: { heading: '^## (R[0-9]+)$', cite: '\\[(R[0-9]+)\\]' } } }, templates: [{
    id: 'supported', applies_to: 'claim', type: 'choice', instructions: 'Check {unit.text} {unit.fields.actor}',
    criteria: { supported: 'Supported', unsupported: 'Unsupported', redundant: 'Redundant' }, expected: ['supported'],
    state: ['unit', 'unit.cited_rows', 'output.body'], dimension: 'accuracy', severity: 'major',
    traps: Object.fromEntries(trapKinds.map(kind => [kind, ['format-paraphrase', 'option-permutation'].includes(kind) ? 'unchanged' : kind === 'injected-redundancy' ? 'redundant' : 'unsupported'])),
  }] });
  const inputs = { output: { headline: 'Work update', body: ['Dr Alice is paid 1,000 dollars [R1].', 'Dr Bob was promoted [R2].'] },
    context: { evidence: '## R1\nDr Alice is paid 1,000 dollars.\n## R2\nDr Bob was promoted.' } };
  const document = parseDecomposition({ schema: 'paideia.decomposition.v1', output: { from: 'out.json', sha256: 'b'.repeat(64) }, context: {},
    units: [
      { id: 'c1', kind: 'claim', text: inputs.output.body[0], paragraph: 0, cites: ['R1'], fields: { actor: 'Dr Alice', quantity: '1,000' }, source_span: 'Dr Alice is paid 1,000 dollars.' },
      { id: 'c2', kind: 'claim', text: inputs.output.body[1], paragraph: 1, cites: ['R2'], fields: { actor: 'Dr Bob' } },
    ], extractors: [{ provider: 'codex', model: 'test', prompt_digest: 'a'.repeat(64), at: '2026-10-11T12:00:00Z' }] });
  return { templates, document, inputs };
}
