import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const run = promisify(execFile), root = fileURLToPath(new URL("../../../../", import.meta.url));
const directory = "src/compiler/training/preparation";
const title = "records link type and target without duplicating payload";
const mutations = [
  { name: "link preservation", before: "files.push(link);\n      return;",
    after: "files.push(...await sealTree(await realpath(root), target, options));\n      return;", assertion: "link identity guarantee" },
  { name: "explicit link identity", before: '...(target !== undefined ? { type: "symlink" as const, target } : {})',
    after: "...{}", assertion: "link identity guarantee" },
  { name: "link target digest", before: 'hashJson({ type: "symlink", target })',
    after: 'hashJson({ type: "symlink" })', assertion: "link target digest guarantee" },
  { name: "staged link type", before: 'await symlink(file.target, target);\n      if (await readlink(target) !== file.target) throw Error("Training source changed during staging");',
    after: "await copyFile(file.source, target, 1);", assertion: "link copy guarantee" }
];

it("kills link preservation, identity, target digest and staging mutants in an isolated source copy", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "training-link-mutations-"));
  try {
    await mkdir(path.join(sandbox, directory), { recursive: true }); await mkdir(path.join(sandbox, "tmp"));
    for (const file of ["package.json", "vitest.config.ts", `${directory}/files.ts`, `${directory}/files.symlinks.test.ts`]) {
      await cp(path.join(root, file), path.join(sandbox, file));
    }
    await symlink(path.join(root, "node_modules"), path.join(sandbox, "node_modules"));
    const file = path.join(sandbox, directory, "files.ts"), original = await readFile(file, "utf8");
    for (const mutation of mutations) {
      expect(original.split(mutation.before), mutation.name).toHaveLength(2);
      await writeFile(file, original.replace(mutation.before, mutation.after));
      try {
        await rm(path.join(sandbox, "coverage/vitest-results.json"), { force: true });
        const result = await run(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--coverage.enabled=false",
          "--maxWorkers=1", "--minWorkers=1", `${directory}/files.symlinks.test.ts`, "-t", title], {
          cwd: sandbox, timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, TMPDIR: path.join(sandbox, "tmp") }
        }).then(() => ({ code: 0 }), (error: { code: number }) => error);
        expect(result.code, `${mutation.name}: mutant survived or runner did not complete`).toBe(1);
        const report = JSON.parse(await readFile(path.join(sandbox, "coverage/vitest-results.json"), "utf8")) as {
          testResults: { assertionResults: { fullName: string; status: string; failureMessages: string[] }[] }[];
        };
        const failed = report.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === "failed");
        expect(failed, mutation.name).toHaveLength(1);
        expect(failed[0]!.fullName).toContain(title);
        expect(failed[0]!.failureMessages.join("\n"), mutation.name).toContain(mutation.assertion);
      } finally { await writeFile(file, original); }
    }
  } finally { await rm(sandbox, { recursive: true, force: true }); }
}, 120_000);
