import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const mutations = [
  { file: "candidate.ts", before: "await writeFile(file, resource.content, { mode: 0o600 });", after: "void resource.content;",
    test: "candidate.test.ts", title: "compiles candidate overlay", assertion: "candidate overlay guarantee" },
  { file: "candidate.ts", before: 'resource.edit === "locked" || options.editablePaths', after: "false || options.editablePaths",
    test: "candidate.test.ts", title: "refuses changed locked", assertion: "locked overlay guarantee" },
  { file: "slot.ts", before: "receipt.projection_sha256 !== projection.projectionSha256 ||", after: "",
    test: "slot.test.ts", title: "refuses native evidence drift", assertion: "slot preflight guarantee" },
  { file: "recycle.ts", before: "result.slot !== slot || result.nonce !== nonce", after: "false",
    test: "recycle.test.ts", title: 'foreign or malformed recycle acknowledgement {"slot":0}', assertion: "recycle identity guarantee" }
];

it("kills overlay, locked resource, preflight and recycle mutants with their actual failing assertions", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "session-mutants-")), run = promisify(execFile);
  try {
    for (const name of ["src", "package.json", "vitest.config.ts", "runtimes.yaml", "moltnet-releases.json"]) {
      await cp(path.join(root, name), path.join(sandbox, name), { recursive: true });
    }
    await symlink(path.join(root, "node_modules"), path.join(sandbox, "node_modules"));
    await mkdir(path.join(sandbox, "tmp"));
    const prefix = "src/compiler/training/session";
    for (const mutation of mutations) {
      const file = path.join(sandbox, prefix, mutation.file), original = await readFile(file, "utf8");
      expect(original.split(mutation.before)).toHaveLength(2);
      await writeFile(file, original.replace(mutation.before, mutation.after));
      await rm(path.join(sandbox, "coverage/vitest-results.json"), { force: true });
      let code: number | undefined;
      try {
        await run(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--coverage.enabled=false",
          "--maxWorkers=1", "--minWorkers=1", `${prefix}/${mutation.test}`, "-t", mutation.title],
        { cwd: sandbox, timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, TMPDIR: path.join(sandbox, "tmp") } });
      } catch (error) { code = (error as { code: number }).code; }
      expect(code, `${mutation.file}: mutant survived`).toBe(1);
      const report = JSON.parse(await readFile(path.join(sandbox, "coverage/vitest-results.json"), "utf8"));
      const failures = report.testResults.flatMap((suite: { assertionResults: { status: string; failureMessages: string[] }[] }) => suite.assertionResults)
        .filter((test: { status: string }) => test.status === "failed");
      expect(failures).toHaveLength(1);
      expect(failures[0].failureMessages.join("\n")).toContain(mutation.assertion);
      await writeFile(file, original);
    }
  } finally { await rm(sandbox, { recursive: true, force: true }); }
}, 120_000);
