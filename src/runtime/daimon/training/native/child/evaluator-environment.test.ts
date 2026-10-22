import { afterEach, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { launchFixture } from '../test-fixtures.js';
import { nativeChildEnvironment } from './arguments.js';
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });


it('never inherits the evaluator TypeSafe key or secret-file binding into the subject environment', async () => {
  const f = await launchFixture(); roots.push(f.root);
  f.launch.workspace.target = f.launch.workspace.source;
  for (const row of f.launch.projections) row.target = row.source;
  vi.stubEnv('TYPESAFE_API_KEY', 'EVALUATOR_ONLY_MARKER');
  vi.stubEnv('PAIDEIA_TYPESAFE_SECRET_FILE', '/run/paideia/secrets/typesafe');
  vi.stubEnv('PAIDEIA_EVALUATOR_ROUTES_FILE', '/run/paideia/evaluator-routes.json');
  const env = await nativeChildEnvironment(f.launch);
  expect(env, 'evaluator secret never enters subject environment').not.toHaveProperty('TYPESAFE_API_KEY');
  expect(env).not.toHaveProperty('PAIDEIA_TYPESAFE_SECRET_FILE');
  expect(env).not.toHaveProperty('PAIDEIA_EVALUATOR_ROUTES_FILE');
  expect(JSON.stringify(env)).not.toContain('EVALUATOR_ONLY_MARKER');
});
