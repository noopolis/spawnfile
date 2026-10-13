import { expect, it } from 'vitest';
import { instantiateChecks, parseCheckTemplates } from './index.js';
import { fixture } from './fixtures.js';

function snapshotFixture(pair = false) {
  const f = fixture();
  f.inputs.output = { body: ['Alice is paid 1,000 dollars [R1].', 'Bob was promoted [R2].'] };
  f.templates.context.source_snapshots = { description: 'Caller-validated snapshots with covered row IDs' };
  f.templates.templates[0]!.state = ['unit', pair ? 'unit.pair.source_snapshots' : 'unit.source_snapshots'];
  f.templates.templates[0]!.instructions = 'Check sources';
  if (pair) f.document.units[0]!.pair = { left: { text: 'Alice is paid 1,000 dollars' }, right: { text: 'Bob was promoted' } };
  f.inputs.context.source_snapshots = [{ url: 'https://a.test', text: 'Full source A', cites: ['R1'] },
    { url: 'https://unused.test', text: 'Unrelated source', cites: ['R3'] }];
  return f;
}

it('parses scoped snapshot reads and selects only sources bound to the verified unit rows', () => {
  const f = snapshotFixture();
  expect(parseCheckTemplates(f.templates)).toEqual(f.templates);
  const undeclared = structuredClone(f.templates);
  delete undeclared.context.source_snapshots;
  expect(() => parseCheckTemplates(undeclared)).toThrow('undeclared context source_snapshots');
  const [check] = instantiateChecks(f.templates, f.document, f.inputs);
  expect(check!.status).toBe('ready');
  expect(check!.projection['unit.source_snapshots']).toEqual([{ url: 'https://a.test', text: 'Full source A', cites: ['R1'] }]);
  f.inputs.context.source_snapshots = [];
  expect(instantiateChecks(f.templates, f.document, f.inputs)[0]!.status).toBe('missing');
});

it('requires coverage of both pair endpoints, while source-independent checks remain ready', () => {
  const f = snapshotFixture(true);
  f.templates.templates.push({ ...f.templates.templates[0]!, id: 'independent', state: ['unit'] });
  const checks = instantiateChecks(f.templates, f.document, f.inputs);
  expect(checks.map(c => c.status)).toEqual(['missing', 'ready']);
  expect(checks[0]!.reasons).toEqual(['missing state unit.pair.source_snapshots']);
  (f.inputs.context.source_snapshots as unknown[]).push({ url: 'https://b.test', text: 'Full source B', cites: ['R2'] });
  const [covered] = instantiateChecks(f.templates, f.document, f.inputs);
  expect(covered!.status).toBe('ready');
  expect(covered!.projection['unit.pair.source_snapshots']).toHaveLength(2);
  delete f.document.units[0]!.pair;
  expect(instantiateChecks(f.templates, f.document, f.inputs)[0]!.status).toBe('missing');
});

it('keeps unknown rows, uncited units, absent declarations and malformed snapshot coverage missing', () => {
  const f = snapshotFixture();
  for (const sources of [undefined, {}, [null, 'bad', {}, { cites: 'R1' }, { cites: ['R2'] }]]) {
    f.inputs.context.source_snapshots = sources;
    expect(instantiateChecks(f.templates, f.document, f.inputs)[0]!.status).toBe('missing');
  }
  f.inputs.context.source_snapshots = [{ cites: ['R1', 'R9'] }];
  f.inputs.output = { body: ['Alice is paid 1,000 dollars [R9].'] };
  expect(instantiateChecks(f.templates, f.document, f.inputs)[0]!.status).toBe('missing');
  f.inputs.output = { body: ['Alice is paid 1,000 dollars.'] };
  expect(instantiateChecks(f.templates, f.document, f.inputs)[0]!.status).toBe('missing');
  f.templates.context = {};
  expect(instantiateChecks(f.templates, f.document, f.inputs)[0]!.status).toBe('missing');
});
