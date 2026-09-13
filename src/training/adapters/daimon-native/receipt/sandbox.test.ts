import assert from 'node:assert/strict';
import { test } from 'vitest';
import { bindNativeSandboxProjection, parseNativeSandboxProjection, parseNativeSandboxReceipt } from './sandbox.js';
import { sandboxProjectionFixture } from '../test-fixtures.js';

test('owner projection and digest are bound to exact native roots, agent, config and trial', () => {
  const projection = sandboxProjectionFixture();
  const bound = bindNativeSandboxProjection(projection, 'trial', 'a'.repeat(64));
  const expected = { trialId: 'trial', configSha256: 'a'.repeat(64), agentId: projection.agentId,
    workspacePath: projection.workspacePath, runtimeHomePath: projection.runtimeHomePath };
  assert.deepEqual(parseNativeSandboxReceipt(bound, expected), bound);
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    assert.throws(() => parseNativeSandboxReceipt(bound, { ...expected, [key]: 'different' }), /not bound/);
  }
  assert.throws(() => parseNativeSandboxReceipt({ ...bound, projectionSha256: 'f'.repeat(64) }, expected), /not bound/);
  assert.throws(() => parseNativeSandboxProjection({ ...projection, sandboxArgs: [...projection.sandboxArgs.slice(0, -1), 'permissions=other'] }), /arguments disagree/);
  assert.throws(() => parseNativeSandboxProjection({ ...projection, version: 'old' }));
});
