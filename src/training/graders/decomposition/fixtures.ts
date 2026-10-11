import { parseCheckTemplates, parseDecomposition } from './index.js';
import type { CheckTemplates, Decomposition, DecompositionInputs } from './index.js';

export const receipt = { provider: 'codex', model: 'test', prompt_digest: 'a'.repeat(64), at: '2026-10-11T12:00:00Z' };
export function fixture(): { templates: CheckTemplates; document: Decomposition; inputs: DecompositionInputs } {
  const templates = parseCheckTemplates({ schema: 'paideia.check-templates.v1', context: {
    evidence: { rows: { heading: '^## (R[0-9]+)$', cite: '\\[(R[0-9]+)\\]' } }, assignment: { role: 'assignment' } }, templates: [{
    id: 'supported', applies_to: 'claim', type: 'noul', instructions: 'Check {unit.text} for {unit.fields.actor}.',
    criteria: { true: 'Supported', false: 'Unsupported' }, expected: [true], state: ['unit', 'unit.cited_rows'], dimension: 'accuracy', severity: 'critical',
  }] });
  const inputs = { output: { headline: 'City update', body: ['Alice is paid 1,000 dollars [R1].', 'Bob was promoted.'] },
    context: { evidence: 'preamble\n## R1\nAlice is paid 1,000 dollars.\n## R2\nBob was promoted.', assignment: 'Cover the pay change.' } };
  const document = parseDecomposition({ schema: 'paideia.decomposition.v1', output: { from: 'output.json', sha256: 'b'.repeat(64) },
    context: {}, units: [{ id: 'c1', kind: 'claim', text: inputs.output.body[0], paragraph: 0, sentence: 0, cites: ['R1'], fields: { actor: 'Alice' } }], extractors: [receipt] });
  return { templates, document, inputs };
}

