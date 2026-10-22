import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const test = "src/compiler/training/container/nativeSlots.test.ts";
const launch = "src/compiler/training/container/launch.ts";
const descriptor = "src/compiler/training/container/nativeSlots.ts";
const mutations: { file: string; before: string; after: string; title: string; test?: string }[] = [
  { file: launch, before: "nativeTrainingSlotsDocument(prepared.config.slots, uid)", after: "nativeTrainingSlotsDocument(1, uid)", title: "mounts" },
  { file: launch, before: "nativeTrainingSlotsDocument(prepared.config.slots, uid)", after: "nativeTrainingSlotsDocument(prepared.config.slots, uid + 1)", title: "mounts" },
  { file: launch, before: "} else {\n      const slotsFile", after: "} else if (false) {\n      const slotsFile", title: "mounts" },
  { file: launch, before: "dst=${TRAINING_SLOTS_FILE},readonly", after: "dst=${TRAINING_SLOTS_FILE}", title: "mounts" },
  { file: launch, before: 'mode: 0o444, flag: "wx"', after: 'mode: 0o644, flag: "wx"', title: "mounts" },
  { file: descriptor, before: "index * TRAINING_PORT_STRIDE", after: "0", title: "mounts" },
  { file: descriptor, before: "roots: {}", after: 'roots: { workspace: "/run/training/slots/0/workspace" }', title: "mounts" },
  { file: descriptor, before: "spawnfile.training-slots.v2", after: "spawnfile.training-slots.v1", title: "mounts" },
  { file: descriptor, before: "assertTrainingSlotCount(slots)", after: "slots", title: "bounds native slots" },
  { file: launch, before: "String(512 * prepared.config.slots)", after: '"512"', title: "mounts" },
  { file: launch, before: "4 * prepared.config.slots", after: "4", title: "mounts" },
  { file: launch, before: "size=${prepared.config.slots}g", after: "size=1g", title: "mounts" },
  { file: launch, before: "/home/training:rw,nosuid,nodev,size=${prepared.config.slots}g", after: "/home/training:rw,nosuid,nodev,size=1g", title: "mounts" },
  { file: "src/compiler/training/container/prepare.ts", before: 'if (!value || !/^[1-8]$/u.test(value) || Number(value) > config.slots)', after: 'if (!value || !/^[1-8]$/u.test(value))', title: "rejects native oversubscription" },
];

it("kills native slot mutants through behavioral assertions in isolated copies", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "native-slot-mutations-"));
  try {
    await cp(join(root, "src"), join(sandbox, "src"), { recursive: true, filter: entry => !/[\\/]\.venv(?:[\\/]|$)/.test(entry) });
    await cp(join(root, "package.json"), join(sandbox, "package.json"));
    await symlink(join(root, "node_modules"), join(sandbox, "node_modules"));
    await writeFile(join(sandbox, "vitest.config.mjs"), 'export default {test:{include:["src/**/*.test.ts"]}};');
    for (const mutation of mutations) {
      const file = join(sandbox, mutation.file), original = await readFile(file, "utf8");
      expect(original.includes(mutation.before), mutation.before).toBe(true);
      await writeFile(file, original.replaceAll(mutation.before, mutation.after));
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
