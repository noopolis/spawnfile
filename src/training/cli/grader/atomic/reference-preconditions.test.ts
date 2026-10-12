import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { redundancyFixture } from './fixtures.js';
import { runDecompose, runReference, runTraps } from './index.js';

it.each(['unsupported', null])('does not score saved defect traps when the current base final is %s', async answer => {
  const f = await redundancyFixture();
  await runDecompose(f.decompose, f.dependencies);
  f.generate.mockImplementation(async request => ({
    text: '{"q1":{"answer":"supported"}}', model: request.model, route: 'subscription', usage: null,
  }));
  const baseline = join(f.root, 'baseline.json');
  await runReference({ ...f.reference, traps: undefined, out: baseline }, f.dependencies);
  expect(await runTraps({ ...f.traps, references: baseline })).toMatchObject({ generated: 2 });
  const trapFile = join(f.traps.out, (await readdir(f.traps.out))[0]!);
  const trapBytes = await readFile(trapFile, 'utf8');
  const bundle = JSON.parse(trapBytes);
  const defect = bundle.traps.find((trap: { kind: string }) => trap.kind === 'injected-redundancy');
  const control = bundle.traps.find((trap: { kind: string }) => trap.kind === 'option-permutation');

  f.generate.mockClear();
  f.generate.mockImplementation(async request => {
    // The repetition must never reach a teacher after its baseline stops being good.
    expect(request.prompt).not.toContain(`Next paragraph. ${f.unit.text}`);
    return { text: JSON.stringify(answer === null ? {} : { q1: { answer } }),
      model: request.model, route: 'subscription', usage: null };
  });
  const result = await runReference(f.reference, f.dependencies);
  expect(result).toMatchObject({ gate: 'STOP', outputs: 2,
    knownAnswer: { total: 0, correct: 0, accuracy: null },
    coverage: { total: 1, covered: 0 }, consistency: { total: 1 },
  });
  const artifact = JSON.parse(await readFile(result.file, 'utf8'));
  expect(Object.keys(artifact.outputs).sort()).toEqual([
    bundle.decomposition, `${bundle.decomposition}:${control.id}`,
  ].sort());
  expect(artifact.outputs).not.toHaveProperty(`${bundle.decomposition}:${defect.id}`);
  expect(artifact.outputs[bundle.decomposition].checks['support@x1'].final).toBe(answer);
  expect(f.generate).toHaveBeenCalled();
  expect(await readFile(trapFile, 'utf8')).toBe(trapBytes);
  expect(await readFile(result.reportFile, 'utf8')).toContain('Known-answer accuracy: unmeasured (no validated traps) (0/0).');
});
