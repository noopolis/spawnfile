import { describe, expect, it } from 'vitest';
import { headingSections, lockedSegments, selectSections } from './headings.js';
import { validateMappings } from './validation.js';
import type { ResourceMapping } from './types.js';

const resource: ResourceMapping = { id: 'a', sourcePath: 'a.md', destinations: [{ kind: 'instructions', path: 'a.md' }], edit: 'whole-file' };
describe('CommonMark section boundaries', () => {
  it('uses heading ancestry and ignores headings inside fenced code and block quotes', () => {
    const text = '# Agent\n## Craft\nUse **plain prose**.\n```md\n# False heading\n```\n> # Quoted heading\n### Detail\nDetails.\n## Policy\nLocked.\n';
    expect(headingSections(text).map(heading => heading.ancestry)).toEqual([['Agent'], ['Agent', 'Craft'], ['Agent', 'Craft', 'Detail'], ['Agent', 'Policy']]);
    const sections = selectSections(text, [['Agent', 'Craft']]);
    expect(lockedSegments(text, sections)).toEqual(['# Agent\n## Craft', '## Policy\nLocked.\n']);
  });
  it('supports setext headings and inline formatting in selectors without rewriting bytes', () => {
    const text = 'Agent\n=====\n\n## **Craft**\nText.\n';
    expect(selectSections(text, [['Agent', 'Craft']])[0]!.start).toBe(text.indexOf('\nText.'));
    expect(selectSections('# Agent', [['Agent']])[0]!.end).toBe(7);
  });
  it('rejects missing, duplicate, invalid and overlapping subtree selectors', () => {
    for (const selectors of [[], [[]], [['']], [['Missing']], [['Agent'], ['Agent', 'Craft']], [['Agent', 'Craft'], ['Agent', 'Craft']]]) {
      expect(() => selectSections('# Agent\n## Craft\nText', selectors)).toThrow();
    }
    expect(() => selectSections('# Empty', [['Empty'], ['Empty']])).toThrow(/overlap/);
    expect(() => selectSections('# Duplicate\na\n# Duplicate\nb', [['Duplicate']])).toThrow(/ambiguous/);
  });
});
describe('native mapping validation', () => {
  it.each([
    [],
    [{ ...resource, id: '../bad' }],
    [resource, resource],
    [resource, { ...resource, id: 'b' }],
    [{ ...resource, destinations: [] }],
    [{ ...resource, destinations: [{ kind: 'invented', path: 'a' }] }],
    [resource, { ...resource, id: 'b', sourcePath: 'b', destinations: [{ kind: 'supporting-files', path: 'a.md/child' }] }],
    [{ ...resource, edit: 'anything' }],
    [{ ...resource, edit: { headings: [['A']], extra: true } }],
  ].map(value => [value]))('rejects ambiguous or unsupported mapping declarations', value => expect(() => validateMappings(value as ResourceMapping[])).toThrow());
});
