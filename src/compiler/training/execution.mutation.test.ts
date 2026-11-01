import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function runOwned(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }, timeoutMs = 25_000) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { ...options, detached: true, stdio: "ignore" });
    let reaped = false;
    const timer = setTimeout(() => {
      // Only signal the group while its leader is still ours; a reaped PID may be reused.
      if (reaped || child.pid === undefined) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }, timeoutMs);
    child.once("exit", () => { reaped = true; clearTimeout(timer); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(Object.assign(new Error("Mutation runner did not succeed"), { code, signal }));
    });
  });
}

it("reaps a timed-out runner and its worker before restoring the mutation copy", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mutation-process-group-"));
  const pidFile = path.join(directory, "worker-pid");
  let worker = 0;
  const script = `const {spawn}=require('node:child_process');const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(worker.pid));setInterval(()=>{},1000);`;
  const stopped = runOwned(["-e", script], { cwd: directory, env: { ...process.env, TYPESAFE_API_KEY: undefined } }, 2_000)
    .then(() => new Error("Runner unexpectedly succeeded"), (error: unknown) => error);
  try {
    // Observe the worker while alive: a missing worker cannot prove descendant cleanup.
    await vi.waitFor(async () => { worker = Number(await readFile(pidFile, "utf8")); expect(worker).toBeGreaterThan(0); }, 1_500);
    expect(() => process.kill(worker, 0)).not.toThrow();
    expect(await stopped).toMatchObject({ code: null, signal: "SIGKILL" });
    await vi.waitFor(() => expect(() => process.kill(worker, 0), "owned worker cleanup guarantee")
      .toThrow(expect.objectContaining({ code: "ESRCH" })), 5_000);
  } finally {
    await stopped;
    if (worker) { try { process.kill(worker, "SIGKILL"); } catch { /* Already reaped. */ } }
    await rm(directory, { recursive: true, force: true });
  }
});

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
  { name: "dataset bytes captured with parsed moments", file: "src/compiler/training/plan/load.ts",
    before: 'createHash("sha256").update(bytes).digest("hex")', after: '"0".repeat(64)',
    test: "src/compiler/training/plan/load.test.ts", title: "reads dataset YAML", assertion: "dataset capture guarantee" },
  { name: "ambiguous short-name refusal", file: "src/compiler/training/selection.ts",
    before: "if (matches.length === 1)", after: "if (matches.length >= 1)",
    test: "src/compiler/training/selection.test.ts", title: "prefers exact IDs", assertion: "ambiguous selection guarantee" },
  { name: "dry-run isolation", file: "src/cli/trainCommand.ts",
    before: "if (lowered && options.dryRun === true)", after: "if (false)",
    test: "src/cli/trainCommand.execution.test.ts", title: "prints a complete lowered dry-run", assertion: "dry-run isolation guarantee" },
];

let sandbox: string;
beforeAll(async () => {
  sandbox = await mkdtemp(path.join(os.tmpdir(), "spawnfile-execution-mutations-"));
  // An isolated source tree avoids racing the normal suite and never mutates public files.
  for (const file of ["src", "package.json", "vitest.config.ts", "runtimes.yaml", "moltnet-releases.json"]) {
    await cp(path.join(root, file), path.join(sandbox, file), { recursive: true,
      filter: entry => !/[\\/](?:\.venv|__pycache__|\.pytest_cache)(?:[\\/]|$)/.test(entry) });
  }
  await symlink(path.join(root, "node_modules"), path.join(sandbox, "node_modules"));
  await mkdir(path.join(sandbox, "coverage")); await mkdir(path.join(sandbox, "tmp"));
});
afterAll(async () => { if (sandbox) await rm(sandbox, { recursive: true, force: true }); });

// Each independent guarantee owns one bounded runner, rather than sharing an
// aggregate deadline across 27 cold Vitest starts on a small machine.
it.each(mutations)("kills $name in an isolated source copy", async mutation => {
  const file = path.join(sandbox, mutation.file), original = await readFile(file, "utf8");
  expect(original.split(mutation.before), mutation.name).toHaveLength(2);
  await writeFile(file, original.replace(mutation.before, mutation.after));
  try {
    // Delete stale evidence; run exactly one mutant against its intended assertion.
    await rm(path.join(sandbox, "coverage/vitest-results.json"), { force: true });
    let result: { code: number | null } | undefined;
    try {
      await runOwned([path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--coverage.enabled=false",
        "--maxWorkers=1", "--minWorkers=1", mutation.test, "-t", mutation.title], {
        // Leave time to reap the child and restore the shared copy before this case expires.
        cwd: sandbox,
        env: { ...process.env, TYPESAFE_API_KEY: undefined, TMPDIR: path.join(sandbox, "tmp") }
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
}, 30_000);
