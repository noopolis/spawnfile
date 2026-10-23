import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
const run = promisify(execFile), root = fileURLToPath(new URL("../../../../", import.meta.url));
it("kills the removed-export mutant with the host receipt assertion", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "output-volume-mutation-"));
  try {
    for (const file of ["src", "package.json", "vitest.config.ts"]) await cp(path.join(root, file), path.join(sandbox, file), { recursive: true, filter: entry => !/[\\/]\.venv(?:[\\/]|$)|[\\/]__pycache__(?:[\\/]|$)|[\\/]\.pytest_cache(?:[\\/]|$)/.test(entry) });
    await symlink(path.join(root, "node_modules"), path.join(sandbox, "node_modules"));
    await mkdir(path.join(sandbox, "tmp"));
    const file = path.join(sandbox, "src/compiler/training/container/outputVolume.ts");
    const original = await readFile(file, "utf8"), before = 'await transfer("export"); exported = true;';
    expect(original.split(before)).toHaveLength(2);
    await writeFile(file, original.replace(before, "exported = true;"));
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: path.join(sandbox, "tmp") }; delete env.TYPESAFE_API_KEY;
    const result = await run(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--coverage.enabled=false",
      "--maxWorkers=1", "--minWorkers=1", "src/compiler/training/container/outputVolume.test.ts", "-t", "exports the volume before verifying"],
    { cwd: sandbox, timeout: 30000, maxBuffer: 1024 * 1024, env }).then(() => ({ code: 0 }), (error: { code: number }) => error);
    expect(result.code, "removed export must fail the targeted runner").toBe(1);
    const report = JSON.parse(await readFile(path.join(sandbox, "coverage/vitest-results.json"), "utf8")) as {
      testResults: { assertionResults: { status: string; failureMessages: string[] }[] }[];
    };
    const failures = report.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === "failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.failureMessages.join("\n")).toContain("host receipt export guarantee");
  } finally { await rm(sandbox, { recursive: true, force: true }); }
}, 60000);
