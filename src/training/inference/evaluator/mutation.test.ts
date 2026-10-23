import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
const run = promisify(execFile);
const mutations = [
  { file: 'src/training/cli/training/inference.ts', before: " || trainingEnvironment('SPAWNFILE_TRAINING_EVALUATOR_ROUTES_FILE') !== undefined",
    after: '', test: 'src/training/cli/training/request-cap.test.ts', title: 'budgets proposals with a shared judge model' },
  { file: 'src/training/inference/evaluator/policy.ts', before: 'value.provider === provider && value.purpose === purpose && value.model === model',
    after: 'value.provider === provider', test: 'src/training/inference/evaluator/evaluator.test.ts', title: 'admits only exact explicitly' },
  { file: 'src/training/inference/evaluator/ledger.ts', before: 'calls.size >= selected.route.maxRequests', after: 'false',
    test: 'src/training/inference/evaluator/evaluator.test.ts', title: 'charges before dispatch' },
  { file: 'src/training/inference/evaluator/ledger.ts', before: 'spent + estimatedUsd > selected.route.maxSpendUsd', after: 'false',
    test: 'src/training/inference/evaluator/evaluator.test.ts', title: 'enforces independent spend ceilings' },
  { file: 'src/training/inference/evaluator/ledger.ts', before: "appendFileSync(fd, `${JSON.stringify(admitted)}\\n`); fsyncSync(fd);", after: '',
    test: 'src/training/inference/evaluator/evaluator.test.ts', title: 'charges before dispatch' },
  { file: 'src/training/inference/evaluator/provider.ts', before: 'const admission = reserveEvaluatorRequest(name, purpose, model);',
    after: "const admission = { finish() {} };", test: 'src/training/cli/training/request-cap.test.ts', title: 'budgets explicitly declared Codex proposals' },
  { file: 'src/training/inference/decision/typesafe/transport.ts', before: 'const admission = evaluatorCapped', after: 'const admission = false',
    test: 'src/training/inference/evaluator/evaluator.test.ts', title: 'loads the key only into evaluator transport' },
  { file: 'src/training/inference/evaluator/provider.ts', before: 'return { TYPESAFE_API_KEY: key };',
    after: 'process.env.TYPESAFE_API_KEY = key; return { TYPESAFE_API_KEY: key };',
    test: 'src/training/inference/evaluator/evaluator.test.ts', title: 'loads the key only into evaluator transport' },
  { file: 'src/runtime/daimon/training/native/child/arguments.ts', before: 'const env: NodeJS.ProcessEnv = { HOME: home.target };',
    after: 'const env: NodeJS.ProcessEnv = { ...process.env, HOME: home.target };',
    test: 'src/runtime/daimon/training/native/child/evaluator-environment.test.ts', title: 'never inherits the evaluator' },
];
it('kills each evaluator admission, request, spend, receipt and secret-isolation mutant with its behavioral test', async () => {
  const source = resolve('.'), root = await mkdtemp(join(tmpdir(), 'evaluator-mutations-'));
  try {
    await cp(join(source, 'src/training'), join(root, 'src/training'), { recursive: true,
      filter: entry => !/[\\/]\.venv(?:[\\/]|$)/.test(entry) });
    await cp(join(source, 'src/shared'), join(root, 'src/shared'), { recursive: true });
    await cp(join(source, 'src/runtime/daimon/training'), join(root, 'src/runtime/daimon/training'), { recursive: true });
    for (const file of ['package.json', 'tsconfig.json']) await cp(join(source, file), join(root, file));
    await writeFile(join(root, 'vitest.config.mjs'), 'export default {test:{include:["src/**/*.test.ts"]}};');
    await symlink(resolve('node_modules'), join(root, 'node_modules'));
    await mkdir(join(root, 'tmp'));
    for (const mutation of mutations) {
      const file = join(root, mutation.file), original = await readFile(file, 'utf8');
      expect(original.includes(mutation.before), `mutation anchor: ${mutation.file}`).toBe(true);
      await writeFile(file, original.replace(mutation.before, mutation.after));
      let output = '', code = 0;
      try {
        const result = await run(process.execPath, [join(source, 'node_modules/vitest/vitest.mjs'), 'run', mutation.test,
          '-t', mutation.title, '--coverage.enabled=false'], { cwd: root, env: { ...process.env, TMPDIR: join(root, 'tmp') }, timeout: 15000, maxBuffer: 1024 * 1024 });
        output = result.stdout + result.stderr;
      } catch (error) {
        const result = error as { code?: number; stdout?: string; stderr?: string };
        code = result.code ?? -1; output = (result.stdout ?? '') + (result.stderr ?? '');
      } finally { await writeFile(file, original); }
      expect(code, `mutant must fail: ${mutation.file}`).toBe(1);
      expect(output, `behavioral assertion must kill: ${mutation.file}`).toContain('AssertionError');
      expect(output).toContain(mutation.title);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60000);
