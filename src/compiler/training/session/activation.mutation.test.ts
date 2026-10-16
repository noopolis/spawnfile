import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const mutations = [
  { file: "src/compiler/training/execution.ts", testFile: "src/compiler/training/session/activation.source-root.test.ts",
    before: "return { ...execution, args: flags.sort(", after: "const { sourceRoot: _sourceRoot, ...withoutSourceRoot } = execution;\n  return { ...withoutSourceRoot, args: flags.sort(",
    title: "binds the enclosing root to exact resume", assertion: "activation source root resume guarantee" },
  { file: "src/compiler/training/session/candidate.ts", testFile: "src/compiler/training/session/activation.source-root.test.ts",
    before: 'bundleCacheDirectory: options.compileOptions?.bundleCacheDirectory ?? path.join(out, "bundle-cache")',
    after: "bundleCacheDirectory: options.compileOptions?.bundleCacheDirectory",
    title: "compiles a nested", assertion: "activation enclosing source guarantee" },
  { file: "src/compiler/training/execution.ts", testFile: "src/compiler/training/session/activation.source-root.test.ts",
    before: "args, output, sourceRoot });", after: "args, output });",
    title: "compiles a nested", assertion: "declared enclosing source guarantee" },
  { file: "src/compiler/training/execution.ts", testFile: "src/compiler/training/session/activation.source-root.test.ts",
    before: "{ sourceRoot: map(execution.sourceRoot) }", after: "{ sourceRoot: execution.sourceRoot }",
    title: "compiles a nested", assertion: "mapped enclosing source guarantee" },
  { before: "return compileTrainingCandidate({ ...input, context, editablePaths, sourceRoot });",
    after: "return compileTrainingCandidate({ ...input, context, editablePaths });",
    testFile: "src/compiler/training/session/activation.source-root.test.ts",
    title: "compiles a nested", assertion: "activation enclosing source guarantee" },
  { before: "if (!isDeepStrictEqual(plan, execution.authoring))", after: "if (false)",
    title: "refuses authoring and context", assertion: "activation authoring identity guarantee" },
  { before: "if (!isDeepStrictEqual(canonical, context))", after: "if (false)",
    title: "refuses authoring and context", assertion: "activation context identity guarantee" },
  { before: "if (!isDeepStrictEqual([...execution.datasetPins].sort((left, right) => (left.sourcePath < right.sourcePath ? -1 : left.sourcePath > right.sourcePath ? 1 : 0)), expectedPins))", after: "if (false)",
    title: "refuses incomplete, duplicate", assertion: "activation dataset pin guarantee" },
  { before: "if (!isDeepStrictEqual(await pins(out), receipt.files))", after: "if (false)",
    title: "resumes only exact pinned", assertion: "activation resume byte pin guarantee" },
  { before: "!isDeepStrictEqual(receipt.identity, identity)", after: "false",
    title: "refuses changed resume identity", assertion: "activation resume identity guarantee" },
  { before: "else args[index + 1] = file;", after: "else void file;",
    title: "activates the emitted v4", assertion: "activation dataset replacement guarantee" },
  { before: "if (!isDeepStrictEqual(receipt.datasets, expectedDatasets))", after: "if (false)",
    title: "refuses resume dataset-role omission", assertion: "activation complete resume roles guarantee" },
  { before: "return compileTrainingCandidate({ ...input, context, editablePaths, sourceRoot });", after: "return compileTrainingCandidate({ ...input, context, sourceRoot });",
    title: "binds authored editability", assertion: "activation authored editability guarantee" },
  { file: "src/compiler/training/context.ts", testFile: "src/compiler/training/context.relocation.test.ts",
    before: 'path.relative(root, resource.scope.key).split(path.sep).join("/")', after: "resource.scope.key",
    title: "activates host-to-container", assertion: "relocated resource identity guarantee" },
  { file: "src/compiler/training/context.ts", testFile: "src/compiler/training/context.relocation.test.ts",
    before: "await pinWorkspaceBundle(resource, { identityRoot: root })", after: "await pinWorkspaceBundle(resource)",
    title: "keeps generated bundle", assertion: "relocated generated pin guarantee" }
];

it("kills activation identity, pins, lowering handoff and compiler binding mutants", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "activation-mutants-")), run = promisify(execFile);
  try {
    for (const name of ["src", "package.json", "vitest.config.ts", "runtimes.yaml", "moltnet-releases.json"]) {
      await cp(path.join(root, name), path.join(sandbox, name), { recursive: true });
    }
    await symlink(path.join(root, "node_modules"), path.join(sandbox, "node_modules"));
    await mkdir(path.join(sandbox, "tmp"));
    const prefix = "src/compiler/training/session";
    for (const mutation of mutations) {
      const file = path.join(sandbox, mutation.file ?? `${prefix}/activation.ts`);
      const original = await readFile(file, "utf8");
      expect(original.split(mutation.before)).toHaveLength(2);
      await writeFile(file, original.replace(mutation.before, mutation.after));
      await rm(path.join(sandbox, "coverage/vitest-results.json"), { force: true });
      let code: number | undefined;
      try {
        await run(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--coverage.enabled=false",
          "--maxWorkers=1", "--minWorkers=1", mutation.testFile ?? `${prefix}/activation.test.ts`, "-t", mutation.title],
        { cwd: sandbox, timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, TMPDIR: path.join(sandbox, "tmp") } });
      } catch (error) { code = (error as { code: number }).code; }
      expect(code, `${mutation.assertion}: mutant survived`).toBe(1);
      const report = JSON.parse(await readFile(path.join(sandbox, "coverage/vitest-results.json"), "utf8"));
      const failures = report.testResults.flatMap((suite: { assertionResults: { status: string; failureMessages: string[] }[] }) => suite.assertionResults)
        .filter((test: { status: string }) => test.status === "failed");
      expect(failures).toHaveLength(1);
      expect(failures[0].failureMessages.join("\n")).toContain(mutation.assertion);
      await writeFile(file, original);
    }
  } finally { await rm(sandbox, { recursive: true, force: true }); }
}, 240_000);
