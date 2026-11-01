import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const loader = "src/training/experiments/concurrency/slots.ts";
const mutations: { file: string; before: string; after: string; title: string; test: string }[] = [
  { file: loader, before: "prior.workerUid === slot.workerUid && !sharedIdentity", after: "false", title: "keeps v1 identity rules", test: "src/training/experiments/concurrency/slots.test.ts" },
  { file: loader, before: "prior.ports.base < slot.ports.base + slot.ports.count && slot.ports.base < prior.ports.base + prior.ports.count", after: "false", title: "keeps v1 identity rules", test: "src/training/experiments/concurrency/slots.test.ts" },
  { file: loader, before: "z.array(sharedUidSlotSchema).min(1).max(8)", after: "z.array(slotSchema).min(1).max(8)", title: "loads", test: "src/training/experiments/concurrency/slots.test.ts" },
];

it("kills slot loader mutants through behavioral assertions in isolated copies", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "slot-mutations-"));
  try {
    await cp(join(root, "src/training"), join(sandbox, "src/training"), { recursive: true, filter: entry => !/[\\/]\.venv(?:[\\/]|$)/.test(entry) });
    await cp(join(root, 'src/shared'), join(sandbox, 'src/shared'), { recursive: true });
    await cp(join(root, 'src/runtime'), join(sandbox, 'src/runtime'), { recursive: true });
    await cp(join(root, 'fixtures/support/training'), join(sandbox, 'fixtures/support/training'), { recursive: true });
    await cp(join(root, "package.json"), join(sandbox, "package.json"));
    await symlink(join(root, "node_modules"), join(sandbox, "node_modules"));
    await writeFile(join(sandbox, "vitest.config.mjs"), 'export default {test:{include:["src/**/*.test.ts"]}};');
    for (const mutation of mutations) {
      const file = join(sandbox, mutation.file), original = await readFile(file, "utf8");
      expect(original.includes(mutation.before), mutation.before).toBe(true);
      await writeFile(file, original.replace(mutation.before, mutation.after));
      try {
        let code: unknown;
        try {
          await run(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run", "--configLoader", "runner",
            "--maxWorkers=1", "--reporter=json", "--outputFile=results.json", mutation.test, "-t", mutation.title],
          { cwd: sandbox, timeout: 30000, maxBuffer: 1024 * 1024,
            env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD/iu.test(key))) });
          code = 0;
        } catch (error) { code = (error as { code?: unknown }).code; }
        expect(code, mutation.before).toBe(1);
        const report = JSON.parse(await readFile(join(sandbox, "results.json"), "utf8")) as {
          testResults: { assertionResults: { status: string; fullName: string }[] }[] };
        const failures = report.testResults.flatMap(suite => suite.assertionResults).filter(row => row.status === "failed");
        expect(failures.length, mutation.before).toBeGreaterThan(0);
        expect(failures.every(row => row.fullName.includes(mutation.title)), mutation.before).toBe(true);
      } finally { await writeFile(file, original); }
    }
  } finally { await rm(sandbox, { recursive: true, force: true }); }
}, 180000);
