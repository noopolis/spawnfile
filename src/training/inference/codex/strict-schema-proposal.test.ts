import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { Ajv } from 'ajv';
import { expect, it } from 'vitest';
import { codexStrictSchema, normalizeCodexResponse } from './strict-schema.js';

it('accepts the actual DSPy proposal schema and preserves its closed impact array', async () => {
  // Exercise the bridge producer itself so a copied fixture cannot hide schema drift.
  const { stdout } = await promisify(execFile)(resolve('bridges/dspy/.venv/bin/python'), ['-c', [
    'import json',
    'from paideia_dspy.reflection import proposal_schema',
    'components = {"type": "object", "properties": {"AGENTS.md": {"type": "string"}},',
    '              "required": ["AGENTS.md"], "additionalProperties": False}',
    'print(json.dumps(proposal_schema(components)))',
  ].join('\n')], { timeout: 10_000 });
  const original = JSON.parse(stdout) as Record<string, unknown>;
  const strict = codexStrictSchema(original);
  const validate = new Ajv().compile(strict);
  const impact = { criterion: 'grounding', effect: 'Fewer unsupported claims.' };
  const response = { components: { 'AGENTS.md': 'Verify citations.' }, hypothesis: 'Verification addresses errors.',
    expectedImpact: [impact] };
  expect(validate(response)).toBe(true);
  expect(JSON.parse(normalizeCodexResponse(JSON.stringify(response), original))).toEqual(response);
  expect(validate({ ...response, expectedImpact: Array.from({ length: 20 }, (_, i) => ({ ...impact, criterion: `c${i}` })) })).toBe(true);
  for (const expectedImpact of [
    { grounding: impact.effect }, [], Array(21).fill(impact),
    [{ criterion: 'grounding' }], [{ effect: impact.effect }], [{ ...impact, extra: true }],
    [{ ...impact, criterion: null }], [{ ...impact, effect: null }],
  ]) expect(validate({ ...response, expectedImpact })).toBe(false);
});
