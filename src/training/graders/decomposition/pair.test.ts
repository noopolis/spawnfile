import { expect, it } from 'vitest';
import { instantiateChecks, locateOutputSpan, parseCheckTemplates, parseExtractionResponse, validateDecomposition } from './index.js';
import { fixture } from './fixtures.js';

function pairFixture() {
  const f = fixture();
  f.inputs.output = { headline: 'City update', body: ['Alice is paid 1,000 dollars [R1].', 'Bob was promoted [R2].'] };
  f.document.units[0]!.pair = { left: { text: 'Alice is paid 1,000 dollars' }, right: { text: 'Bob was promoted' } };
  f.templates.templates[0]!.state = ['unit', 'unit.cited_rows', 'unit.pair', 'unit.pair.cited_rows'];
  f.templates.templates[0]!.instructions = '{unit.pair.left.text} / {unit.pair.right.text} / {unit.pair.cited_rows.left}';
  return f;
}

it('strictly parses optional pairs and declared pair reads without widening arbitrary nested reads', () => {
  const f = pairFixture();
  expect(parseCheckTemplates(f.templates)).toEqual(f.templates);
  expect(parseExtractionResponse(JSON.stringify({ units: f.document.units })).units[0]!.pair).toEqual(f.document.units[0]!.pair);
  const base = f.document.units[0]!;
  for (const pair of [{ left: base.pair!.left }, { ...base.pair, extra: 'invented' },
    { ...base.pair, right: { text: ' ' } }, { ...base.pair, right: { text: 'Bob', offset: 99 } }]) {
    expect(() => parseExtractionResponse(JSON.stringify({ units: [{ ...base, pair }] }))).toThrow();
  }
  f.templates.templates[0]!.state = ['unit.pair.left'];
  expect(() => parseCheckTemplates(f.templates)).toThrow();
});

it('independently derives endpoint addresses and citations and keeps frame/left/right rows separate', () => {
  const f = pairFixture();
  Object.assign(f.document.units[0]!.pair!.right, { location: 'headline', paragraph: 9, sentence: 9, cites: ['R1'] });
  const result = validateDecomposition(f.document, f.inputs, f.templates);
  expect(result.rejected).toEqual([]);
  expect(result.decomposition.units[0]!.pair).toEqual({
    left: { text: 'Alice is paid 1,000 dollars', location: 'body', paragraph: 0, sentence: 0, cites: ['R1'] },
    right: { text: 'Bob was promoted', location: 'body', paragraph: 1, sentence: 0, cites: ['R2'] },
  });
  expect(result.citationDisagreements).toEqual([{ id: 'c1.pair.right', supplied: ['R1'], derived: ['R2'] }]);
  const [instance] = instantiateChecks(f.templates, f.document, f.inputs);
  expect(instance!.status).toBe('ready');
  expect(instance!.projection['unit.cited_rows']).toEqual([{ id: 'R1', text: '## R1\nAlice is paid 1,000 dollars.\n', context: 'evidence' }]);
  expect(instance!.projection['unit.pair.cited_rows']).toEqual({
    left: instance!.projection['unit.cited_rows'],
    right: [{ id: 'R2', text: '## R2\nBob was promoted.', context: 'evidence' }],
  });
  expect(instance!.instructions).toContain('Alice is paid 1,000 dollars / Bob was promoted /');
  expect(instantiateChecks(f.templates, f.document, f.inputs)[0]!.digest).toBe(instance!.digest);
  f.document.units[0]!.pair = { left: f.document.units[0]!.pair!.right, right: f.document.units[0]!.pair!.left };
  expect(instantiateChecks(f.templates, f.document, f.inputs)[0]!.digest).not.toBe(instance!.digest);
});

it.each(['left', 'right'] as const)('rejects a forged %s endpoint even with a valid frame and opposite endpoint', side => {
  const f = pairFixture();
  f.document.units[0]!.pair![side].text = 'Invented relation endpoint';
  const result = validateDecomposition(f.document, f.inputs, f.templates);
  expect(result.decomposition.units).toEqual([]);
  expect(result.rejected[0]!.reasons).toContain(`pair.${side}: text is not a verbatim source span`);
  const [instance] = instantiateChecks(f.templates, f.document, f.inputs);
  expect(instance!.status).toBe('missing');
});

it('refuses assignment-only pair endpoints even when the anchor is an obligation', () => {
  const f = pairFixture();
  const unit = f.document.units[0]!;
  unit.kind = 'obligation'; unit.text = 'Cover the pay change.';
  unit.pair!.left.text = unit.text;
  f.templates.templates[0]!.applies_to = 'obligation';
  const result = validateDecomposition(f.document, f.inputs, f.templates);
  expect(result.rejected[0]!.reasons).toEqual(['pair.left: text is not a verbatim source span']);
});

it('requires independent occurrence hints for ambiguous endpoints and derives exact source offsets', () => {
  const f = pairFixture();
  f.inputs.output = { body: ['Alice is paid 1,000 dollars [R1].', 'Bob was promoted [R2].', 'Bob was promoted [R1].'] };
  const unit = f.document.units[0]!;
  expect(validateDecomposition(f.document, f.inputs, f.templates).rejected[0]!.reasons).toContain('pair.right: ambiguous source span');
  unit.pair!.right.paragraph = 2;
  const checked = validateDecomposition(f.document, f.inputs, f.templates);
  expect(checked.rejected).toEqual([]);
  expect(checked.decomposition.units[0]!.pair!.right.cites).toEqual(['R1']);
  expect(locateOutputSpan(unit.pair!.right, f.inputs, f.templates)).toMatchObject({ paragraph: 2, offset: 0 });
  unit.pair!.right.paragraph = 8;
  expect(validateDecomposition(f.document, f.inputs, f.templates).rejected[0]!.reasons).toContain('pair.right: ambiguous source span');
});

it('removes forged body hints and citations from non-body endpoints', () => {
  const f = pairFixture();
  f.document.units[0]!.pair!.right = { text: 'City update', location: 'body', paragraph: 1, sentence: 0, cites: ['R2'] };
  const result = validateDecomposition(f.document, f.inputs, f.templates);
  expect(result.decomposition.units[0]!.pair!.right).toEqual({ text: 'City update', location: 'headline', cites: [] });
  expect(result.citationDisagreements).toEqual([{ id: 'c1.pair.right', supplied: ['R2'], derived: [] }]);
  expect(instantiateChecks(f.templates, f.document, f.inputs)[0]!.projection['unit.pair.cited_rows']).toMatchObject({ right: [] });
});

it.each(['left', 'right'] as const)('rejects unknown derived %s row IDs and keeps pair evidence missing', side => {
  const f = pairFixture();
  const body = ['Alice is paid 1,000 dollars [R1].', 'Bob was promoted [R2].'];
  body[side === 'left' ? 0 : 1] = body[side === 'left' ? 0 : 1]!.replace(/R[12]/, 'R9');
  f.inputs.output = { body };
  // Keep a verified frame when changing the left endpoint's sentence.
  f.document.units[0]!.text = 'Alice is paid 1,000 dollars';
  const [instance] = instantiateChecks(f.templates, f.document, f.inputs);
  expect(instance!.status).toBe('missing');
  expect(instance!.reasons).toContain(`pair.${side}: unknown cited row`);
  expect(instance!.reasons).toContain('missing state unit.pair.cited_rows');
  expect(instance!.projection).not.toHaveProperty('unit.pair.cited_rows');
});

it('keeps missing pairs, absent row declarations and invalid row contexts missing', () => {
  const f = pairFixture();
  delete f.document.units[0]!.pair;
  expect(instantiateChecks(f.templates, f.document, f.inputs)[0]!.reasons).toEqual(expect.arrayContaining([
    'missing state unit.pair', 'missing state unit.pair.cited_rows',
  ]));
  const uncited = pairFixture();
  uncited.inputs.output = { body: ['Alice is paid 1,000 dollars [R1].', 'Bob was promoted.'] };
  expect(instantiateChecks(uncited.templates, uncited.document, uncited.inputs)[0]!.projection['unit.pair.cited_rows']).toMatchObject({ right: [] });
  uncited.templates.context = {};
  expect(instantiateChecks(uncited.templates, uncited.document, uncited.inputs)[0]!.reasons).toContain('missing state unit.pair.cited_rows');
  const invalid = pairFixture();
  invalid.inputs.context.evidence = null;
  const [instance] = instantiateChecks(invalid.templates, invalid.document, invalid.inputs);
  expect(instance!.status).toBe('missing');
  expect(instance!.reasons).toContain('pair.left: missing or oversized row context evidence');
  expect(instance!.reasons).toContain('pair.right: missing or oversized row context evidence');
});
