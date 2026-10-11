import { expect, it } from 'vitest';
import { instantiateChecks, validateDecomposition } from './index.js';
import { fixture } from './fixtures.js';

it('rejects citations redirected to existing rows and missing real citations', () => {
  const { templates, document, inputs } = fixture();
  for (const cites of [['R2'], [], undefined]) {
    document.units[0]!.cites = cites;
    expect(validateDecomposition(document, inputs, templates).rejected[0]!.reasons).toContain('cites do not match source citations');
  }
});

it('binds uncited subspans to the containing sentence, including leading-citation policy', () => {
  const { templates, document, inputs } = fixture();
  inputs.output = { body: ['Alice is paid. [R1] Bob was promoted [R2].'] };
  document.units[0]!.text = 'Alice is paid.';
  document.units[0]!.cites = [];
  expect(validateDecomposition(document, inputs, templates).rejected).toEqual([]);
  templates.context.evidence!.rows!.leading_citations = 'previous';
  expect(validateDecomposition(document, inputs, templates).rejected[0]!.reasons).toContain('cites do not match source citations');
  document.units[0]!.cites = ['R1'];
  expect(validateDecomposition(document, inputs, templates).rejected).toEqual([]);
  document.units[0]!.text = 'Bob was promoted';
  document.units[0]!.sentence = 1;
  document.units[0]!.cites = ['R2'];
  expect(validateDecomposition(document, inputs, templates).rejected).toEqual([]);
  document.units[0]!.sentence = 0;
  expect(validateDecomposition(document, inputs, templates).rejected[0]!.reasons).toContain('sentence does not contain span');
});

it('requires source spans to occur within a cited row', () => {
  const { templates, document, inputs } = fixture();
  for (const source_span of ['Fabricated evidence', 'Bob was promoted.', ' ']) {
    document.units[0]!.source_span = source_span;
    expect(validateDecomposition(document, inputs, templates).rejected[0]!.reasons).toContain('source_span is not a verbatim cited row span');
  }
  document.units[0]!.source_span = 'Alice\n is paid 1,000 dollars.';
  expect(validateDecomposition(document, inputs, templates).rejected).toEqual([]);
});

it('drops and reports fabricated fields and never skips a missing applicability field', () => {
  const { templates, document, inputs } = fixture();
  document.units[0]!.fields = { actor: 'Invented', modality: 'uncertain', quantity: '1,000', action: ' ' };
  const validation = validateDecomposition(document, inputs, templates);
  expect(validation.decomposition.units[0]!.fields).toEqual({ quantity: '1,000' });
  expect(validation.dropped.map(item => item.field)).toEqual(['actor', 'action', 'modality']);
  expect(validation.rejected).toEqual([]);
  templates.templates[0]!.when = { field: 'modality', equals: 'certain' };
  const checks = instantiateChecks(templates, document, inputs);
  expect(checks).toHaveLength(1);
  expect(checks[0]).toMatchObject({ status: 'missing', reasons: expect.arrayContaining(['missing condition field modality']) });
  expect((checks[0]!.projection.unit as { fields: object }).fields).toEqual({ quantity: '1,000' });
});

it('rejects ambiguous unlocated spans but accepts explicitly located citations', () => {
  const { templates, document, inputs } = fixture();
  inputs.output = { body: ['Alice is paid [R1]. Alice is paid [R2].'] };
  document.units[0]!.text = 'Alice is paid';
  delete document.units[0]!.sentence;
  expect(validateDecomposition(document, inputs, templates).rejected).toHaveLength(1);
  document.units[0]!.sentence = 0;
  expect(validateDecomposition(document, inputs, templates).rejected).toEqual([]);
});
