import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const test = "src/adapters/daimon-native/container/slot.test.ts";
const verifier = "src/adapters/daimon-native/container/slot.ts";
const loader = "src/experiments/concurrency/slots.ts";
const mutations: { file: string; before: string; after: string; title: string; test?: string }[] = [
  { file: verifier, before: "launch.host.port < slot.ports.base", after: "false", title: "always checks its port block" },
  { file: verifier, before: "!Number.isSafeInteger(slot.ports.base)", after: "false", title: "always checks its port block" },
  { file: verifier, before: "!Number.isSafeInteger(slot.ports.count)", after: "false", title: "always checks its port block" },
  { file: verifier, before: "launch.host.port >= slot.ports.base + slot.ports.count", after: "false", title: "always checks its port block" },
  { file: "src/adapters/daimon-native/container/manifest.ts", before: "if (input.slot) assertLeasedLaunch(launch, input.slot);", after: "", title: "always checks its port block" },
  { file: verifier, before: "declared.source !== root", after: "false", title: "binds every declared Codex root" },
  { file: verifier, before: "declared.target !== root", after: "false", title: "binds every declared Codex root" },
  { file: verifier, before: "matches?.length !== 1 ||", after: "false ||", title: "binds every declared Codex root" },
  { file: verifier, before: "slot.workerUid !== process.geteuid?.()", after: "false", title: "always checks its port block" },
  { file: verifier, before: "isGrokLaunch(launch) ||", after: "false ||", title: "always checks its port block" },
  { file: verifier, before: "if (slot.isolation === 'shared-uid')", after: "if (false)", title: "always checks its port block" },
  { file: loader, before: "prior.workerUid === slot.workerUid && !sharedIdentity", after: "false", title: "keeps v1 identity rules", test: "src/experiments/concurrency/slots.test.ts" },
  { file: loader, before: "prior.ports.base < slot.ports.base + slot.ports.count && slot.ports.base < prior.ports.base + prior.ports.count", after: "false", title: "keeps v1 identity rules", test: "src/experiments/concurrency/slots.test.ts" },
  { file: loader, before: "z.array(sharedUidSlotSchema).min(1).max(8)", after: "z.array(slotSchema).min(1).max(8)", title: "loads", test: "src/experiments/concurrency/slots.test.ts" },
];

it("kills native slot mutants through behavioral assertions in isolated copies", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "native-slot-mutations-"));
  try {
    await cp(join(root, "src"), join(sandbox, "src"), { recursive: true });
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
            "--maxWorkers=1", "--reporter=json", "--outputFile=results.json", mutation.test ?? test, "-t", mutation.title],
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
