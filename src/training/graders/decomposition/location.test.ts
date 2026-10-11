import { expect, it } from 'vitest';
import { instantiateChecksReport, parseCheckTemplates, validateDecomposition } from './index.js';
import { fixture } from './fixtures.js';

it('locates display fields and body spans despite wrong hints and derives trailing cites', () => {
  const { templates, document, inputs } = fixture();
  templates.context.evidence!.rows!.leading_citations = 'previous';
  templates.kinds = { display: 'Headline, deck and kicker spans.', sentence: 'Verbatim sentences.' };
  inputs.output = { headline: 'Harbor update', deck: 'Work begins today', kicker: 'Local news',
    body: ['Crews arrived. [R1][R2] The harbor reopened. [R2]'] };
  document.units = [
    { id: 'h', kind: 'display', text: 'Harbor update', paragraph: 0, sentence: 0, cites: ['R1'] },
    { id: 'd', kind: 'display', text: 'Work\n begins today', paragraph: 9, sentence: 1 },
    { id: 'k', kind: 'display', text: 'Local news', location: 'body' },
    { id: 's', kind: 'sentence', text: 'Crews arrived.', paragraph: 8, sentence: 1, cites: ['R2'] },
    { id: 'c', kind: 'claim', text: 'The harbor reopened.', paragraph: 0, sentence: 0, cites: ['R1'] },
  ];
  const result = validateDecomposition(document, inputs, templates);
  expect(result.rejected).toEqual([]);
  expect(result.decomposition.units.map(({ id, location, paragraph, sentence, cites }) =>
    ({ id, location, paragraph, sentence, cites }))).toEqual([
    { id: 'h', location: 'headline', cites: [], paragraph: undefined, sentence: undefined },
    { id: 'd', location: 'deck', cites: [], paragraph: undefined, sentence: undefined },
    { id: 'k', location: 'kicker', cites: [], paragraph: undefined, sentence: undefined },
    { id: 's', location: 'body', paragraph: 0, sentence: 0, cites: ['R1', 'R2'] },
    { id: 'c', location: 'body', paragraph: 0, sentence: 1, cites: ['R2'] },
  ]);
  expect(result.citationDisagreements).toHaveLength(3);
  expect(validateDecomposition(result.decomposition, inputs, templates)).toMatchObject({ rejected: [], citationDisagreements: [] });
  expect(document.units[0]!.paragraph).toBe(0); // Caller input is not mutated.
});

it('rejects invented and ambiguous occurrences; only consistent hints break ties', () => {
  const { templates, document, inputs } = fixture();
  inputs.output = { headline: 'Same words', body: ['Same words. Same words.', 'Same words.'] };
  const unit = { id: 'c1', kind: 'claim', text: 'Same words' };
  const check = (hints: object) => validateDecomposition({ ...document, units: [{ ...unit, ...hints }] }, inputs, templates);
  for (const hints of [{}, { paragraph: 9 }, { paragraph: 0 }, { location: 'headline', paragraph: 0 }, { cites: ['R1'] }]) {
    expect(check(hints).rejected[0]!.reasons).toEqual(['ambiguous source span']);
  }
  expect(check({ paragraph: 0, sentence: 1 }).decomposition.units[0]).toMatchObject({ location: 'body', paragraph: 0, sentence: 1 });
  expect(check({ location: 'headline' }).decomposition.units[0]).toMatchObject({ location: 'headline', cites: [] });
  expect(check({ paragraph: 1 }).decomposition.units[0]).toMatchObject({ paragraph: 1, sentence: 0 });
  expect(check({ text: 'Invented' }).rejected[0]!.reasons).toContain('text is not a verbatim source span');
  inputs.output = { body: ['Same words and Same words.'] };
  expect(check({ paragraph: 0, sentence: 0 }).rejected[0]!.reasons).toContain('ambiguous source span');
});

it('binds a span crossing ICU sentence boundaries to its first segment and all touched citations', () => {
  const { templates, document, inputs } = fixture();
  templates.context.evidence!.rows!.leading_citations = 'previous';
  inputs.output = { body: ['A U.S. Department memo arrived. [R1] Another memo followed. [R2]'] };
  document.units[0]!.text = 'A U.S. Department memo arrived.';
  expect(validateDecomposition(document, inputs, templates).decomposition.units[0]).toMatchObject({ sentence: 0, cites: ['R1'] });
});

it('reports template location exclusions without hiding rejected spans or missing state', () => {
  const { templates, document, inputs } = fixture();
  templates.templates[0]!.locations = ['body'];
  document.units.push({ id: 'h', kind: 'claim', text: 'City update', paragraph: 0 });
  const result = instantiateChecksReport(templates, document, inputs);
  expect(result.checks.map(check => check.id)).toEqual(['supported@c1']);
  expect(result.skipped).toEqual([{ template_id: 'supported', unit_id: 'h', location: 'headline', reason: 'outside declared template locations' }]);
  expect(instantiateChecksReport(templates, document, inputs)).toEqual(result);
  document.units[1]!.text = 'Invented';
  expect(instantiateChecksReport(templates, document, inputs)).toMatchObject({ skipped: [], checks: [expect.anything(), { status: 'missing' }] });
  expect(() => parseCheckTemplates({ ...templates, kinds: { claim: '' } })).toThrow();
  expect(() => parseCheckTemplates({ ...templates, templates: [{ ...templates.templates[0], locations: [] }] })).toThrow();
  expect(parseCheckTemplates(templates).context.evidence!.rows!.leading_citations).toBe('keep');
});

it('retains source-row guards using derived cites and supports non-body and assignment locations', () => {
  const { templates, document, inputs } = fixture();
  document.units[0]!.cites = ['R2'];
  document.units[0]!.source_span = 'Bob was promoted.';
  expect(validateDecomposition(document, inputs, templates).rejected[0]!.reasons).toContain('source_span is not a verbatim cited row span');
  document.units[0]!.source_span = 'Alice is paid 1,000 dollars.';
  expect(validateDecomposition(document, inputs, templates).rejected).toEqual([]);
  document.units[0]!.text = 'Alice is paid 1,000 dollars [R9].';
  inputs.output = { body: [document.units[0]!.text] };
  expect(validateDecomposition(document, inputs, templates).rejected[0]!.reasons).toContain('unknown cited row');
  document.units = [{ id: 'o', kind: 'obligation', text: 'Cover the pay change.', paragraph: 4 }];
  expect(validateDecomposition(document, inputs).decomposition.units[0]).toMatchObject({ location: 'context.assignment', cites: [] });
  document.units = [{ id: 's', kind: 'claim', text: 'Just text' }];
  expect(validateDecomposition(document, { output: 'Just text', context: {} }).decomposition.units[0]).toMatchObject({ location: 'output', cites: [] });
  expect(validateDecomposition(document, { output: { widget: { caption: 'Just text' } }, context: {} }).decomposition.units[0]!.location).toBe('widget.caption');
});
