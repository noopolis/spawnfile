import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const run = promisify(execFile), root = fileURLToPath(new URL("../../../../", import.meta.url));
const directory = "src/compiler/training/preparation";
const mutations = [
  { file: `${directory}/prepare.ts`, before: 'await claimTrainingPreparationScratch(staging, digest, options.streams.stderr, "resume");',
    after: "", test: `${directory}/prepare.resume.test.ts`, title: "protects a resumed preparation", assertion: "resumed scratch ownership guarantee" },
  { file: `${directory}/scratch.ts`, before: 'await recordOwner("w");', after: "",
    test: `${directory}/prepare.resume.test.ts`, title: "protects a resumed preparation", assertion: "resumed scratch ownership guarantee" },
  { file: `${directory}/scratch.ts`, before: 'try { await mkdir(guard, { mode: 0o700 }); }',
    after: 'try { if (mode !== "resume") await mkdir(guard, { mode: 0o700 }); }',
    test: `${directory}/prepare.resume.test.ts`, title: "refuses resume under an existing recovery guard", assertion: "resume recovery exclusion guarantee" },
  { file: `${directory}/inputs.ts`, before: "input.git.paths.filter(file => !overlayPaths.has(file))", after: "input.git.paths",
    test: `${directory}/inputs.test.ts`, title: "stages tracked overlay destinations once", assertion: "single overlay staging guarantee" },
  { file: `${directory}/prepare.ts`, before: "Promise.allSettled(inputs.map(input => stageInput(input, path.join(staging, input.id))))",
    after: "Promise.all(inputs.map(input => stageInput(input, path.join(staging, input.id))))",
    test: `${directory}/prepare.staging.test.ts`, title: "settles every input before cleanup", assertion: "settled cleanup guarantee" },
  { file: "src/compiler/training/output.ts", before: "!sources.some(source => within(source, candidate) || within(candidate, source))", after: "true",
    test: "src/compiler/training/output.test.ts", title: "places default output", assertion: "disjoint default output guarantee" },
  { file: "src/compiler/training/execution.ts", before: 'defaultTrainingOutputRoot(project.root, declaration.inputs.map(input =>\n    path.resolve(path.dirname(trainingConfig), input.source)))', after: 'path.join(project.root, ".spawn/training")',
    test: "src/compiler/training/execution.test.ts", title: "lowers authored inputs", assertion: "lowered default output guarantee" },
  { file: `${directory}/scratch.ts`, before: 'previous = JSON.parse(await readFile(path.join(staging, "owner.json"), "utf8")) as { digest?: unknown };',
    after: "previous = undefined;", test: `${directory}/scratch.test.ts`, title: "reclaims owned partial staging", assertion: "partial scratch recovery guarantee" },
  { file: `${directory}/scratch.ts`, before: "await chmod(entry, (info.mode & 0o777) | 0o700);", after: "",
    test: `${directory}/scratch.test.ts`, title: "reclaims owned partial staging", assertion: "partial scratch recovery guarantee" },
  { file: `${directory}/scratch.ts`, before: "if (!stopped) throw Error", after: "if (false) throw Error",
    test: `${directory}/scratch.test.ts`, title: "refuses a competing identical launch", assertion: "active scratch ownership guarantee" },
  { file: `${directory}/scratch.ts`, before: "stopped = (error as NodeJS.ErrnoException).code === \"ESRCH\";", after: "stopped = true;",
    test: `${directory}/scratch.test.ts`, title: "requires ESRCH", assertion: "proven scratch death guarantee" },
  { file: `${directory}/scratch.ts`, before: "try { await mkdir(guard, { mode: 0o700 }); }", after: "try { await mkdir(guard, { mode: 0o700, recursive: true }); }",
    test: `${directory}/scratch.test.ts`, title: "refuses an existing recovery guard", assertion: "recovery exclusion guarantee" }
];

it("kills overlay, cleanup, default output and interrupted scratch recovery mutants", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "training-prep-mutations-"));
  try {
    for (const file of ["src", "package.json", "vitest.config.ts", "runtimes.yaml", "moltnet-releases.json"]) {
      await cp(path.join(root, file), path.join(sandbox, file), { recursive: true });
    }
    await symlink(path.join(root, "node_modules"), path.join(sandbox, "node_modules"));
    await mkdir(path.join(sandbox, "tmp"));
    for (const mutation of mutations) {
      const file = path.join(sandbox, mutation.file), original = await readFile(file, "utf8");
      expect(original.split(mutation.before), mutation.file).toHaveLength(2);
      await writeFile(file, original.replace(mutation.before, mutation.after));
      try {
        await rm(path.join(sandbox, "coverage/vitest-results.json"), { force: true });
        const result = await run(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--coverage.enabled=false",
          "--maxWorkers=1", "--minWorkers=1", mutation.test, "-t", mutation.title], {
          cwd: sandbox, timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, TMPDIR: path.join(sandbox, "tmp") }
        }).then(() => ({ code: 0 }), (error: { code: number }) => error);
        expect(result.code, `${mutation.file}: mutant survived or runner did not complete`).toBe(1);
        const report = JSON.parse(await readFile(path.join(sandbox, "coverage/vitest-results.json"), "utf8")) as {
          testResults: { assertionResults: { fullName: string; status: string; failureMessages: string[] }[] }[];
        };
        const failed = report.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === "failed");
        expect(failed, mutation.file).toHaveLength(1);
        expect(failed[0]!.fullName).toContain(mutation.title);
        expect(failed[0]!.failureMessages.join("\n"), mutation.file).toContain(mutation.assertion);
      } finally { await writeFile(file, original); }
    }
  } finally { await rm(sandbox, { recursive: true, force: true }); }
}, 180_000);
