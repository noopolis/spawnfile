import { expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { parseNativeLaunch } from './schema.js';
import { launchFixture } from '../test-fixtures.js';

test('strict versioned receipts reject mutable images, path escapes, unsupported engines and undeclared overrides', async () => {
  const f = await launchFixture();
  try {
    const { receiptFile: _, ...valid } = f.launch;
    expect(parseNativeLaunch(valid)).toEqual(valid);
    for (const mutation of [null, [], { ...valid, extra: true }, { ...valid, schema: 'unknown' }, { ...valid, image: 'latest' },
      { ...valid, config: 'relative' }, { ...valid, config: '/with,comma' }, { ...valid, configSha256: 'unknown' },
      { ...valid, workspace: { ...valid.workspace, target: '/a/../b' } },
      ...['../AGENTS.md', '/AGENTS.md', '..', 'a/../b', 'a\\b'].map(relativePath => ({ ...valid, instructions: { ...valid.instructions, relativePath } })),
      { ...valid, agent: { ...valid.agent, engine: 'other' } }, { ...valid, projections: [] },
      { ...valid, projections: [...valid.projections, valid.projections[0]] },
      { ...valid, limits: { maxTokens: 1, wakeTokenCeiling: 2 } },
      { ...valid, overrides: { ...valid.overrides, selection: { ...valid.overrides.selection, after: ['wrong'] } } },
      { ...valid, overrides: { ...valid.overrides, selection: { ...valid.overrides.selection, before: ['wrong'] } } },
    ]) expect(() => parseNativeLaunch(mutation)).toThrow();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
