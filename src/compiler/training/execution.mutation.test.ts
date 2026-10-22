import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const mutations = [
  { name: "timestamp normalization refusal boundary", file: "src/compiler/training/moments.ts",
    before: 'entries.push(entry);\n      try {\n        const lineage = `moment:${hash([plan.agent.id, normalizeInstant(example.at), example.wake])}`;\n        entry.lineage = lineage;',
    after: 'const lineage = `moment:${hash([plan.agent.id, normalizeInstant(example.at), example.wake])}`;\n      entry.lineage = lineage;\n      entries.push(entry);\n      try {',
    test: "src/compiler/training/moments.test.ts", title: "false: reports an unsupported timestamp", assertion: "timestamp refusal boundary guarantee" },
  { name: "trial provenance binding", file: "src/compiler/training/moments.ts",
    before: "if (!isDeepStrictEqual(result.inputs, expected.inputs) || !isDeepStrictEqual(result.record, expected.record))", after: "if (false)",
    test: "src/compiler/training/moments.test.ts", title: "refuses trial provenance drift", assertion: "trial provenance guarantee" },
  { name: "rewind refusal skip", file: "src/compiler/training/moments.ts",
    before: 'if (moment.status === "refused")', after: "if (false)",
    test: "src/compiler/training/moments.test.ts", title: "uses per-example overrides", assertion: "rewind refusal guarantee" },
  { name: "fresh trial materializer destination", file: "src/compiler/training/moments.ts",
    before: "historyDir: moment.historyDir, out: options.out", after: "historyDir: moment.historyDir, out: moment.momentRoot",
    test: "src/compiler/training/moments.test.ts", title: "rewinds independently", assertion: "fresh rewind destination guarantee" },
  { name: "same historical moment lineage", file: "src/compiler/training/moments.ts",
    before: "hash([plan.agent.id, normalizeInstant(example.at), example.wake])", after: "hash([plan.agent.id, example.id, normalizeInstant(example.at), example.wake])",
    test: "src/compiler/training/moments.test.ts", title: "shares lineage across clones", assertion: "historical lineage guarantee" },
  { name: "validation dataset CLI handoff", file: "src/compiler/training/execution.ts",
    before: 'for (const role of ["train", "validation", "test"] as const)', after: 'for (const role of ["train", "test"] as const)',
    test: "src/compiler/training/execution.test.ts", title: "lowers authored inputs", assertion: "validation CLI handoff guarantee" },
  { name: "validated integration declaration", file: "src/compiler/training/preparation/contract.ts",
    before: "execution: z.literal(TRAINING_EXECUTION_VERSION).optional()", after: "execution: z.string().optional()",
    test: "src/compiler/training/preparation/contract.test.ts", title: "accepts only an explicit supported", assertion: "execution declaration validation guarantee" },
  { name: "packaged integration capability label", file: "src/compiler/training/preparation/image.ts",
    before: 'const capability = build.integration.execution ?? "";', after: 'const capability = "";',
    test: "src/compiler/training/preparation/image.test.ts", title: "binds declared execution capability", assertion: "execution label guarantee" },
  { name: "capability recipe identity", file: "src/compiler/training/preparation/image.ts",
    before: "files: fileIdentity(files), dockerfile, entry, brokerEntry", after: "files: fileIdentity(files), entry, brokerEntry",
    test: "src/compiler/training/preparation/image.test.ts", title: "binds declared execution capability", assertion: "execution identity guarantee" },
  { name: "inherited compatibility refusal", file: "src/compiler/training/preparation/image.ts",
    before: 'const capability = build.integration.execution ?? "";', after: 'const capability = build.integration.execution ?? "spawnfile.training-execution.v1";',
    test: "src/compiler/training/preparation/image.test.ts", title: "binds declared execution capability", assertion: "inherited execution refusal guarantee" },
  { name: "built image capability verification", file: "src/compiler/training/preparation/image.ts",
    before: ' && capability === (plan.build.integration.execution ?? "")', after: "",
    test: "src/compiler/training/preparation/image.test.ts", title: "rejects mismatching capability", assertion: "execution cache verification guarantee" },
  { name: "staged pin confinement", file: "src/compiler/training/preparation/inputs.ts",
    before: 'if (!within(staged[index]!, canonicalFile)) throw Error("Canonical training source escapes its staged input");', after: "",
    test: "src/compiler/training/preparation/inputs.test.ts", title: "accepts confined tracked links", assertion: "staged pin confinement guarantee" },
  { name: "direct dataset byte binding", file: "src/compiler/training/container/launch.ts",
    before: "if (options.execution) await verifyCanonicalPins(", after: "if (false) await verifyCanonicalPins(",
    test: "src/cli/trainCommand.execution.test.ts", title: "rejects a dataset changed after lowering", assertion: "direct dataset binding guarantee" },
  { name: "execution consumer compatibility", file: "src/compiler/training/container/launch.ts",
    before: 'if (capability.code !== 0 || capability.stdout.trim() !== JSON.stringify(TRAINING_EXECUTION_VERSION))', after: "if (false)",
    test: "src/cli/trainCommand.execution.test.ts", title: "rejects missing, wrong-version", assertion: "execution compatibility guarantee" },
  { name: "execution consumer handoff", file: "src/compiler/training/container/launch.ts",
    before: '...(execution ? ["--spawnfile-execution", TRAINING_EXECUTION_FILE] : []),', after: "",
    test: "src/cli/trainCommand.execution.test.ts", title: "runs and resumes", assertion: "execution consumer handoff guarantee" },
  { name: "dataset snapshot binding", file: "src/compiler/training/preparation/prepare.ts",
    before: "...options.execution?.datasetPins ?? []", after: "...[]",
    test: "src/cli/trainCommand.execution.test.ts", title: "rejects authored dataset bytes", assertion: "dataset snapshot guarantee" },
  { name: "dataset bytes captured with parsed moments", file: "src/compiler/training/plan/load.ts",
    before: 'createHash("sha256").update(bytes).digest("hex")', after: '"0".repeat(64)',
    test: "src/compiler/training/plan/load.test.ts", title: "reads dataset YAML", assertion: "dataset capture guarantee" },
  { name: "ambiguous short-name refusal", file: "src/compiler/training/selection.ts",
    before: "if (matches.length === 1)", after: "if (matches.length >= 1)",
    test: "src/compiler/training/selection.test.ts", title: "prefers exact IDs", assertion: "ambiguous selection guarantee" },
  { name: "dry-run isolation", file: "src/cli/trainCommand.ts",
    before: "if (lowered && options.dryRun === true)", after: "if (false)",
    test: "src/cli/trainCommand.execution.test.ts", title: "prints a complete lowered dry-run", assertion: "dry-run isolation guarantee" },
  { name: "validation dataset projection", file: "src/compiler/training/execution.ts",
    before: "validation: target.datasets.validation === null ? null : source(target.datasets.validation)",
    after: "validation: target.datasets.validation", test: "src/compiler/training/execution.test.ts", title: "maps graders", assertion: "validation projection guarantee" },
  { name: "optimizer shape in resume identity", file: "src/compiler/training/preparation/prepare.ts",
    before: "...(options.execution ? { execution: trainingExecutionIdentity(options.execution) } : {}),", after: "",
    test: "src/compiler/training/preparation/prepare.test.ts", title: "binds optimizer shape", assertion: "optimizer resume guarantee" },
  { name: "preparation execution witness handoff", file: "src/compiler/training/preparation/prepare.ts",
    before: "args: options.args, execution: options.execution, inputs,", after: "args: options.args, inputs,",
    test: "src/compiler/training/repair/witness.test.ts", title: "brokered: false, authored: true", assertion: "preparation witness round-trip guarantee" },
  { name: "witness execution serialization", file: "src/compiler/training/repair/witness.ts",
    before: "...(options.execution ? { execution: options.execution } : {}),", after: "",
    test: "src/compiler/training/repair/witness.test.ts", title: "brokered: false, authored: true", assertion: "preparation witness round-trip guarantee" },
  { name: "witness execution identity verification", file: "src/compiler/training/repair/witness.ts",
    before: "...(manifest.execution ? { execution: trainingExecutionIdentity(manifest.execution) } : {}),", after: "",
    test: "src/compiler/training/repair/witness.test.ts", title: "brokered: false, authored: true", assertion: "preparation witness round-trip guarantee" },
  { name: "container execution receipt", file: "src/compiler/training/container/launch.ts",
    before: "...execution ? [`type=bind,src=${executionFile},dst=${TRAINING_EXECUTION_FILE},readonly`] : [],", after: "",
    test: "src/cli/trainCommand.execution.test.ts", title: "runs and resumes", assertion: "execution receipt mount guarantee" },
  { name: "lowered v4 dispatch", file: "src/compiler/training/execution.ts",
    before: "const declaration = preparation ?", after: 'const declaration = raw.version !== "spawnfile.training-container.v1" ?',
    test: "src/compiler/training/execution.test.ts", title: "accepts lowered v4", assertion: "lowered v4 dispatch guarantee" },
  { name: "fresh direct-launch output", file: "src/compiler/training/container/launch.ts",
    before: 'createOutput: options.execution !== undefined && !options.args.includes("--resume")', after: "createOutput: false",
    test: "src/cli/trainCommand.execution.test.ts", title: "creates fresh direct-launch output", assertion: "fresh output launch guarantee" }
];

it("kills each key-guarantee mutant in an isolated source copy, without changing the working tree", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "spawnfile-execution-mutations-"));
  try {
    // An isolated source tree avoids racing the normal suite and never mutates public files.
    for (const file of ["src", "package.json", "vitest.config.ts", "runtimes.yaml", "moltnet-releases.json"]) {
      await cp(path.join(root, file), path.join(sandbox, file), { recursive: true, filter: entry => !/[\\/]\.venv(?:[\\/]|$)/.test(entry) });
    }
    await symlink(path.join(root, "node_modules"), path.join(sandbox, "node_modules"));
    await mkdir(path.join(sandbox, "coverage")); await mkdir(path.join(sandbox, "tmp"));
    for (const mutation of mutations) {
      const file = path.join(sandbox, mutation.file), original = await readFile(file, "utf8");
      expect(original.split(mutation.before), mutation.name).toHaveLength(2);
      await writeFile(file, original.replace(mutation.before, mutation.after));
      try {
        // Delete stale evidence; run exactly one mutant against its intended assertion.
        await rm(path.join(sandbox, "coverage/vitest-results.json"), { force: true });
        let result: { code: number; stdout: string; stderr: string } | undefined;
        try {
          await run(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--coverage.enabled=false",
            "--maxWorkers=1", "--minWorkers=1", mutation.test, "-t", mutation.title], {
            cwd: sandbox, timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, TMPDIR: path.join(sandbox, "tmp") }
          });
        } catch (error) { result = error as typeof result; }
        expect(result?.code, `${mutation.name}: mutant survived or runner did not complete`).toBe(1);
        const report = JSON.parse(await readFile(path.join(sandbox, "coverage/vitest-results.json"), "utf8")) as {
          testResults: { assertionResults: { fullName: string; status: string; failureMessages: string[] }[] }[];
        };
        const assertions = report.testResults.flatMap(suite => suite.assertionResults);
        const failed = assertions.filter(test => test.status === "failed");
        expect(failed, mutation.name).toHaveLength(1);
        expect(failed[0]!.fullName, mutation.name).toContain(mutation.title);
        expect(failed[0]!.failureMessages.join("\n"), mutation.name).toContain(mutation.assertion);
      } finally { await writeFile(file, original); }
    }
  } finally { await rm(sandbox, { recursive: true, force: true }); }
}, 180_000);
