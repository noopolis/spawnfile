import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile), root = fileURLToPath(new URL("../../../../", import.meta.url));
const containerTest = "src/compiler/training/container/evaluators.test.ts";
const preparationTest = "src/compiler/training/preparation/evaluators.test.ts";
const codexTest = "src/compiler/training/container/evaluators.codex.test.ts";
const mutations = [
  { name: "direct resolved subject admission", file: "src/compiler/training/container/prepare.ts",
    before: "  await assertTrainingSubjectIsolation(config, context);", after: "",
    test: codexTest, title: "refuses mismatched Codex isolation subjects", assertion: "Codex resolved subject admission guarantee" },
  { name: "build preparation resolved subject admission", file: "src/compiler/training/preparation/prepare.ts",
    before: "  await assertTrainingSubjectIsolation(config, options.context);", after: "",
    test: preparationTest, title: "refuses mismatched Codex preparation subjects before Docker: build", assertion: "Codex preparation subject admission guarantee" },
  ...[
    'agent.runtime.name !== "daimon"',
    'resolveDaimonEngine(agent) !== "codex"',
    'agent.runtime.options.codex_policy !== "workspace-no-network"',
    'agent.execution?.sandbox?.mode !== "workspace"'
  ].map(condition => ({
    name: `resolved subject ${condition} binding`, file: "src/compiler/training/container/subjectIsolation.ts",
    before: condition,
    after: "false", test: codexTest, title: "refuses mismatched Codex isolation subjects", assertion: "Codex resolved subject admission guarantee"
  })),
  { name: "Codex secret admission", file: "src/compiler/training/container/contract.ts",
    before: '  if (value.evaluatorSecrets && !value.broker && !value.subjectIsolation) context.addIssue({ code: "custom", message: "Evaluator secrets require brokered v4 isolation or explicit codex-native-sandbox subject isolation" });', after: "",
    test: codexTest, title: "admits v1 evaluator secrets", assertion: "Codex secret admission guarantee" },
  { name: "Codex preparation secret admission", file: "src/compiler/training/preparation/contract.ts",
    before: '  if (value.evaluatorSecrets && !value.broker && !value.subjectIsolation) context.addIssue({ code: "custom", message: "Evaluator secrets require brokered v4 isolation or explicit codex-native-sandbox subject isolation" });', after: "",
    test: preparationTest, title: "admits non-broker preparation secrets", assertion: "Codex preparation secret admission guarantee" },
  { name: "Codex evaluator secret mount", file: "src/compiler/training/container/evaluators.ts",
    before: '      mounts.push(`type=bind,src=${secret.source},dst=${TRAINING_TYPESAFE_SECRET_FILE},readonly`);', after: "",
    test: codexTest, title: "binds the Codex evaluator leaf", assertion: "Codex evaluator secret mount guarantee" },
  { name: "root secret staging invocation", file: "src/compiler/training/broker/entrypoint.ts",
    before: "  await stageTrainingEvaluatorSecret();", after: "",
    test: "src/compiler/training/broker/entrypoint.evaluators.test.ts", title: "stages evaluator credentials", assertion: "evaluator secret staging order guarantee" },
  { name: "evaluator uid delivery", file: "src/compiler/training/broker/evaluatorSecrets.ts",
    before: "await target.chown(DAIMON_ORGANIZATION_UID, DAIMON_ORGANIZATION_UID);", after: "",
    test: "src/compiler/training/broker/evaluatorSecrets.test.ts", title: "delivers a host-private leaf", assertion: "evaluator secret ownership delivery guarantee" },
  { name: "bounded evaluator ingress", file: "src/compiler/training/broker/evaluatorSecrets.ts",
    before: "info.size > 64 * 1024", after: "false",
    test: "src/compiler/training/broker/evaluatorSecrets.test.ts", title: "refuses unbounded", assertion: "evaluator secret ingress safety guarantee" },
  { name: "hardlink evaluator ingress", file: "src/compiler/training/broker/evaluatorSecrets.ts",
    before: "info.nlink !== 1 || ", after: "",
    test: "src/compiler/training/broker/evaluatorSecrets.test.ts", title: "refuses unbounded", assertion: "evaluator secret ingress safety guarantee" },
  { name: "positive evaluator request cap", file: "src/compiler/training/container/evaluators.ts",
    before: "maxRequests: z.number().int().positive()", after: "maxRequests: z.number().int().nonnegative()",
    test: containerTest, title: "admits only explicit", assertion: "evaluator route admission guarantee" },
  { name: "subject broker cap", file: "src/compiler/training/container/launch.ts",
    before: '...(broker ? ["--env", "SPAWNFILE_TRAINING_MODEL_REQUEST_CAP=broker"] : []),', after: "",
    test: containerTest, title: "mounts protected evaluator", assertion: "subject broker cap guarantee" },
  { name: "evaluator receipt declaration", file: "src/compiler/training/container/evaluators.ts",
    before: 'receiptPath: path.posix.join(output, "evaluator-requests.jsonl")', after: 'receiptPath: "/run/training/output/other.jsonl"',
    test: containerTest, title: "mounts protected evaluator", assertion: "evaluator declaration guarantee" },
  { name: "run-scoped evaluator receipts", file: "src/compiler/training/container/evaluators.ts",
    before: 'receiptPath: path.posix.join(output, "evaluator-requests.jsonl")', after: 'receiptPath: "/run/training/output/evaluator-requests.jsonl"',
    test: containerTest, title: "binds evaluator receipts to each mapped run", assertion: "run-scoped evaluator receipt guarantee" },
  { name: "evaluator policy env", file: "src/compiler/training/container/evaluators.ts",
    before: "env.push(`SPAWNFILE_TRAINING_EVALUATOR_ROUTES_FILE=${TRAINING_EVALUATOR_ROUTES_FILE}`);", after: "",
    test: containerTest, title: "mounts protected evaluator", assertion: "evaluator env handoff guarantee" },
  { name: "secret read-only mount", file: "src/compiler/training/container/evaluators.ts",
    before: "dst=${TRAINING_TYPESAFE_SECRET_INGRESS},readonly", after: "dst=${TRAINING_TYPESAFE_SECRET_INGRESS}",
    test: containerTest, title: "mounts protected evaluator", assertion: "secret reference guarantee" },
  { name: "direct secret input exclusion", file: "src/compiler/training/container/prepare.ts",
    before: "const protectedLeaves = [...config.auth, ...config.evaluatorSecrets ?? []];", after: "const protectedLeaves = [...config.auth];",
    test: containerTest, title: "rejects evaluator secret exposure", assertion: "secret mount confinement guarantee" },
  { name: "prepared secret input/image exclusion", file: "src/compiler/training/preparation/prepare.ts",
    before: "const protectedLeaves = [...auth, ...evaluatorSecrets ?? []];", after: "const protectedLeaves = [...auth];",
    test: preparationTest, title: "excludes evaluator secrets", assertion: "secret image source confinement guarantee" },
  { name: "compiler package secret exclusion", file: "src/compiler/training/preparation/image.ts",
    before: "  assertInputRoot(ownRoot, auth);", after: "",
    test: preparationTest, title: "excludes evaluator secrets", assertion: "secret image source confinement guarantee" },
  { name: "prepared evaluator authorization", file: "src/compiler/training/preparation/prepare.ts",
    before: "{ evaluatorRoutes: config.evaluatorRoutes }", after: "{ evaluatorRoutes: config.evaluatorRoutes.map(route => ({ ...route, maxRequests: 1 })) }",
    test: preparationTest, title: "preserves evaluator authorization", assertion: "evaluator preparation propagation guarantee" },
  { name: "prepared evaluator secret reference", file: "src/compiler/training/preparation/prepare.ts",
    before: "...(evaluatorSecrets ? { evaluatorSecrets } : {})", after: "...{}",
    test: preparationTest, title: "preserves evaluator authorization", assertion: "evaluator secret propagation guarantee" }
];

it("kills evaluator boundary mutants in isolated source copies with their intended assertions", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "spawnfile-evaluator-mutations-"));
  try {
    for (const file of ["src", "package.json", "vitest.config.ts", "runtimes.yaml", "moltnet-releases.json"])
      await cp(path.join(root, file), path.join(sandbox, file), { recursive: true, filter: entry => !/[\\/]\.venv(?:[\\/]|$)/.test(entry) });
    await symlink(path.join(root, "node_modules"), path.join(sandbox, "node_modules"));
    await mkdir(path.join(sandbox, "coverage")); await mkdir(path.join(sandbox, "tmp"));
    for (const mutation of mutations) {
      const file = path.join(sandbox, mutation.file), original = await readFile(file, "utf8");
      expect(original.split(mutation.before), mutation.name).toHaveLength(2);
      await writeFile(file, original.replace(mutation.before, mutation.after));
      try {
        await rm(path.join(sandbox, "coverage/vitest-results.json"), { force: true });
        let failure: { code?: number } | undefined;
        try {
          await run(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--coverage.enabled=false",
            "--maxWorkers=1", "--minWorkers=1", mutation.test, "-t", mutation.title], {
            cwd: sandbox, timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, TMPDIR: path.join(sandbox, "tmp") }
          });
        } catch (error) { failure = error as { code?: number }; }
        expect(failure?.code, `${mutation.name}: mutant survived or runner failed`).toBe(1);
        const report = JSON.parse(await readFile(path.join(sandbox, "coverage/vitest-results.json"), "utf8")) as {
          testResults: { assertionResults: { status: string; failureMessages: string[] }[] }[];
        };
        const failed = report.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === "failed");
        expect(failed, mutation.name).toHaveLength(1);
        expect(failed[0]!.failureMessages.join("\n"), mutation.name).toContain(mutation.assertion);
      } finally { await writeFile(file, original); }
    }
  } finally { await rm(sandbox, { recursive: true, force: true }); }
}, 180_000);
