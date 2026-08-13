#!/usr/bin/env node
// V for the burnlist loop: the objective, mechanical half of acceptance.
// Exits 0 only when every gate below is green. Severity policy (what a human or
// reviewing agent must decide) lives in notes/burnlists/inprogress/260717-001/V-CRITERIA.md
// — this script is deliberately the part that cannot be argued with.
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import { assertExpectedCases, discoverTestFiles, parseTapSummary } from "./tap-self-test.mjs";

const MAX_NAME_LENGTH = 120;
export const LOOP_VERIFY_SELF_TEST_MINIMUM_CASES = 81;
export const LOOP_VERIFY_REQUIRED_SELF_TEST_CASE_NAMES = ["freshness rejects a vacuous zero-source scan", "freshness rejects missing and empty dist output", "freshness names a source newer than its expected output", "freshness passes with non-zero source and output counts", "freshness rejects an output whose source no longer exists", "TAP summary accepts a non-zero passing plan", "TAP summary rejects a zero plan", "TAP summary rejects empty or garbage output", "freshness fails when a source expected output is missing", "freshness catches one stale mapped source among fresh siblings", "freshness rejects a vacuous zero-pair mapping", "TAP parser rejects zero plan, zero passes, failures, and garbage", "healthy npm receipt with three present matching packages passes", "nested version mismatch is BOOTSTRAP STALE and falls back to npm-ci", "symlinked inherited input is BOOTSTRAP INVALID", "hook materialization copies missing hooks and records the empirical per-worktree exclude", "hook verification fails closed for a missing directory and non-executable hook"];
export { parseTapSummary };
export const stripAnsi = (text) => stripVTControlCharacters(String(text ?? ""));

const shellQuote = (value) => {
  const text = String(value);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text)
    ? text
    : `'${text.replaceAll("'", `'"'"'`)}'`;
};

const rerunCommand = (command, args, cwd) =>
  `cd ${shellQuote(cwd)} && ${[command, ...args].map(shellQuote).join(" ")}`;

const cleanName = (name) => {
  const collapsed = String(name).replace(/\s+/g, " ").trim();
  return collapsed.length <= MAX_NAME_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_NAME_LENGTH - 1)}…`;
};

const extractGoFailures = (lines) => {
  const hasGoEvidence = lines.some((line) =>
    /^\s*--- FAIL: /.test(line)
    || /^(FAIL|ok)\s+\S+/.test(line)
    || /\[build failed\]/.test(line));
  if (!hasGoEvidence) return [];

  const tests = lines.flatMap((line) => {
    const match = line.match(/^\s*--- FAIL: (\S+)/);
    return match ? [match[1]] : [];
  });
  const leaves = tests.filter(
    (name) => !tests.some((other) => other !== name && other.startsWith(`${name}/`)),
  );
  const buildPackages = new Set();
  for (const line of lines) {
    const failed = line.match(/^FAIL\s+(\S+)\s+\[build failed\]\s*$/);
    const block = line.match(/^#\s+(\S+)\s*$/);
    if (failed) buildPackages.add(failed[1]);
    if (block) buildPackages.add(block[1]);
  }
  return [...leaves, ...[...buildPackages].map((pkg) => `build failed: ${pkg}`)];
};

const extractNodeTestFailures = (lines) => {
  const results = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)not ok \d+ - (.+?)(\s+# .*)?$/);
    if (match) results.push({ index, depth: match[1].length, name: match[2].trim() });
  }
  if (results.length === 0) return [];

  const classified = results.map((result, resultIndex) => {
    const next = results[resultIndex + 1]?.index ?? lines.length;
    const block = lines.slice(result.index + 1, next);
    return {
      ...result,
      aggregate: block.some((line) => /failureType:\s*['"]subtestsFailed['"]/.test(line)),
    };
  });
  const leaves = classified.filter(({ aggregate }) => !aggregate);
  if (leaves.length > 0) return leaves.map(({ name }) => name);

  const shallowest = Math.min(...classified.map(({ depth }) => depth));
  return classified.filter(({ depth }) => depth === shallowest).map(({ name }) => name);
};

const extractVitestFailures = (stdoutLines, stderrLines) => {
  const failedTestsAt = stderrLines.findIndex((line) => /Failed Tests\s+\d+/.test(line));
  if (failedTestsAt >= 0) {
    const named = stderrLines.slice(failedTestsAt + 1).flatMap((line) => {
      const match = line.match(/^\s*FAIL\s+(.+)$/);
      return match ? [match[1].trim()] : [];
    });
    if (named.length > 0) return named;
  }

  const allLines = [...stderrLines, ...stdoutLines];
  const collectionFailures = allLines.flatMap((line) => {
    const match = line.match(/^\s*FAIL\s+(.+?)\s+\[\s*.+?\s*\]\s*$/);
    return match ? [`failed to collect: ${match[1].trim()}`] : [];
  });
  if (collectionFailures.length > 0) return collectionFailures;

  const named = stdoutLines.flatMap((line) => {
    const match = line.match(/^\s*×\s+(.+?)(?:\s+\d+(?:\.\d+)?m?s)?\s*$/);
    return match ? [match[1].trim()] : [];
  });
  if (named.length > 0) return named;

  const unhandledAt = allLines.findIndex((line) => /Unhandled Errors/.test(line));
  if (unhandledAt < 0) return [];
  const errorLine = allLines.slice(unhandledAt + 1).find((line) =>
    /^\s*(?:Error|[A-Za-z_$][\w.$]*(?:Error|Exception)):\s*\S.*$/.test(line),
  );
  const detail = errorLine ? `: ${errorLine.trim()}` : "";
  return [`unhandled error (no failing case named)${detail}`];
};

const extractTscFailures = (lines) => lines.flatMap((line) => {
  const located = line.match(/^(.*)\((\d+),(\d+)\): error TS(\d+): (.*)$/);
  if (located) {
    return [`${located[1].trim()}:${located[2]} TS${located[4]}: ${located[5].trim()}`];
  }
  const bare = line.match(/^\s*error TS(\d+): (.*)$/);
  return bare ? [`TS${bare[1]}: ${bare[2].trim()}`] : [];
});

const formatParsedFailure = (label, names, rerun, signal) => {
  const cleaned = names.map(cleanName);
  const shown = cleaned.slice(0, 3).join("; ");
  const more = cleaned.length > 3 ? ` (+${cleaned.length - 3} more)` : "";
  const killed = signal ? ` [killed by ${signal}]` : "";
  return `${label}: ${cleaned.length} failing — ${shown}${more}${killed} [rerun: ${rerun}]`;
};

export const summarizeFailure = ({ label, command, args, cwd, stdout, stderr, error }) => {
  const rerun = rerunCommand(command, args, cwd);
  if (error?.code === "ENOENT") {
    return `${label}: ${command} not found (cannot run gate) [rerun: ${rerun}]`;
  }
  if (error?.code === "ETIMEDOUT" || error?.killed === true) {
    return `${label}: timed out after 900s [rerun: ${rerun}]`;
  }

  const stdoutLines = stripAnsi(stdout).split(/\r?\n/);
  const stderrLines = stripAnsi(stderr).split(/\r?\n/);
  const allLines = [...stdoutLines, ...stderrLines];
  const extractors = [
    () => extractGoFailures(allLines),
    () => extractNodeTestFailures(allLines),
    () => extractVitestFailures(stdoutLines, stderrLines),
    () => extractTscFailures(allLines),
  ];
  for (const extract of extractors) {
    const names = extract();
    if (names.length > 0) return formatParsedFailure(label, names, rerun, error?.signal);
  }

  if (error?.signal) {
    return `${label}: killed by ${error.signal}; output could not be parsed for a failing case name — rerun: ${rerun}`;
  }

  const exitCode = error?.status ?? error?.code ?? "unknown";
  return `${label}: exited ${exitCode}; output could not be parsed for a failing case name — rerun: ${rerun}`;
};
const sourceFile = (entry) => entry.isFile() && entry.name.endsWith(".ts")
  && !entry.name.endsWith(".test.ts")
  && !entry.name.endsWith(".test-helper.ts")
  && !entry.name.endsWith(".d.ts");

const filesUnder = (directory, predicate) => {
  if (!existsSync(directory)) return [];
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (predicate(entry)) files.push(entryPath);
    }
  };
  visit(directory);
  return files;
};

const describeTime = (timestamp) => `${new Date(timestamp).toISOString()} (${timestamp}ms)`;

export const inspectDistLevel = ({ label, sourceDir, distDir, allowedUnmappedDirectories = [] }) => {
  const sources = filesUnder(sourceDir, sourceFile);
  const outputs = filesUnder(distDir, (entry) => entry.isFile() && entry.name.endsWith(".js"));
  const outputSet = new Set(outputs);
  const sourceByOutput = new Map(sources.map((source) => {
    const relativeSource = path.relative(sourceDir, source);
    const expectedOutput = path.join(distDir, relativeSource.replace(/\.ts$/u, ".js"));
    return [expectedOutput, source];
  }));
  const pairs = [];
  const problems = [];

  if (sources.length === 0) problems.push(`${label}: scanned no sources`);
  if (!existsSync(distDir)) problems.push(`${label}: dist directory is absent: ${distDir}`);
  else if (outputs.length === 0) problems.push(`${label}: dist is empty / emitted nothing: ${distDir}`);

  for (const [expectedOutput, source] of sourceByOutput) {
    if (!outputSet.has(expectedOutput)) {
      problems.push(`${label}: missing output for source ${source}: expected ${expectedOutput}`);
      continue;
    }
    pairs.push({ source, output: expectedOutput });
    const sourceTime = statSync(source).mtimeMs;
    const outputTime = statSync(expectedOutput).mtimeMs;
    if (sourceTime > outputTime) {
      problems.push(
        `${label}: stale: source ${source} (${describeTime(sourceTime)}) `
        + `is newer than expected output ${expectedOutput} (${describeTime(outputTime)})`,
      );
    }
  }
  if (pairs.length === 0) problems.push(`${label}: mapped no source/output pairs`);

  const unmappedOutputs = outputs.filter((output) => !sourceByOutput.has(output));
  const allowedUnmappedOutputs = unmappedOutputs.filter((output) =>
    allowedUnmappedDirectories.some((directory) => output.startsWith(`${directory}${path.sep}`)));
  const orphanOutputs = unmappedOutputs.filter((output) => !allowedUnmappedOutputs.includes(output));
  for (const output of orphanOutputs)
    problems.push(`${label}: orphan output ${output}: its source no longer exists`);
  return { label, sources, outputs, pairs, allowedUnmappedOutputs, orphanOutputs, problems };
};

export const checkDistFreshness = ({ simfileDir }) => [
  inspectDistLevel({
    label: "simfile root",
    sourceDir: path.join(simfileDir, "src"),
    distDir: path.join(simfileDir, "dist"),
  }),
];

const main = () => {
  const root = process.env.LOOP_VERIFY_ROOT ?? process.cwd();
  const failures = [];

  const run = (label, command, args, cwd) => {
    // A missing directory used to return silently, so a misaimed root printed
    // "V PASSED" having executed nothing. Absence is now a failure: this script's
    // only value is that its green cannot be argued with.
    if (!existsSync(cwd)) {
      failures.push(`${label}: gate directory does not exist: ${cwd}`);
      process.stdout.write(`FAIL  ${label} (missing ${cwd})\n`);
      return;
    }
    try {
      execFileSync(command, args, { cwd, stdio: "pipe", timeout: 900_000 });
      process.stdout.write(`PASS  ${label}\n`);
    } catch (error) {
      failures.push(summarizeFailure({
        label,
        command,
        args,
        cwd,
        stdout: error?.stdout,
        stderr: error?.stderr,
        error,
      }));
      process.stdout.write(`FAIL  ${label}\n`);
    }
  };
  const runSelfTest = (cwd) => {
    const label = "loop-verify self-test";
    try {
      if (!existsSync(cwd)) throw new Error(`gate directory does not exist: ${cwd}`); const files = discoverTestFiles(path.join(cwd, "scripts"));
      if (files.length === 0) throw new Error("discovered zero self-test files");
      const outputs = files.map((file) => {
        const relative = path.join("scripts", file);
        let output = "";
        try { output = execFileSync("node", ["--test", "--test-reporter=tap", relative], { cwd, encoding: "utf8", stdio: "pipe", timeout: 900_000 }); }
        catch (error) { output = String(error.stdout || "") + String(error.stderr || ""); parseTapSummary(output); throw new Error(`${file} exited ${error.status ?? "unknown"}`); }
        const summary = parseTapSummary(output);
        const passing = new Set([...output.matchAll(/^ok \d+ - (.+?)\s*$/gmu)].map((match) => match[1]));
        const declared = [...readFileSync(path.join(cwd, "scripts", file), "utf8").matchAll(/\btest\(\s*["']([^"']+)["']/gu)].map((match) => match[1]);
        for (const title of declared) if (!passing.has(title)) throw new Error(`${file}: declared test is not passing: ${title}`);
        return { file, output, passed: summary.passed };
      });
      const passed = outputs.reduce((total, file) => total + file.passed, 0); const aggregate = outputs.map(({ output }) => output).join("\n") + `\n1..${passed}\n# pass ${passed}\n# fail 0\n`;
      assertExpectedCases(aggregate, { minimumCases: LOOP_VERIFY_SELF_TEST_MINIMUM_CASES, requiredCaseNames: LOOP_VERIFY_REQUIRED_SELF_TEST_CASE_NAMES });
      process.stdout.write(`PASS  ${label} (${passed} passed, ${files.length} files)\n`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`${label}: ${reason}`);
      process.stdout.write(`FAIL  ${label}: ${reason}\n`);
    }
  };
  // Loop worktrees are created PER REPO, so a lane that worktree'd only Simfile
  // has no `ecosystem/` of its own. LOOP_VERIFY_ROOT alone cannot express that:
  // pointing it at a Simfile worktree would run the root gates inside Simfile.
  // Each repo therefore takes an independent override, so a lane verifies its own
  // worktree for the repo it changed and the real checkout for the rest.
  const spawnfile = process.env.LOOP_VERIFY_SPAWNFILE ?? root;
  const simfile = process.env.LOOP_VERIFY_SIMFILE ?? path.join(root, "ecosystem", "simfile");
  const daimon = process.env.LOOP_VERIFY_DAIMON ?? path.join(root, "ecosystem", "daimon");
  const moltnet = process.env.LOOP_VERIFY_MOLTNET ?? path.join(root, "ecosystem", "moltnet");
  const stele = process.env.LOOP_VERIFY_STELE ?? path.join(root, "ecosystem", "stele");
  const mneme = process.env.LOOP_VERIFY_MNEME ?? path.join(root, "ecosystem", "mneme");

  // Vitest includes only src/**/*.test.ts, so this script gates itself.
  runSelfTest(spawnfile);

  // root Spawnfile — boundary ratchets are vitest
  run("root boundary gates", "npx", [
    "vitest", "run", "--coverage.enabled=false",
    "src/ownership/rootOwnershipBoundary.test.ts",
    "src/deployment/providerRuntimeBoundary.test.ts",
    "src/ownership/mnemePublicImportBoundary.test.ts",
  ], spawnfile);
  run("root typecheck", "npm", ["run", "typecheck"], spawnfile);

  run("simfile typecheck", "npm", ["run", "typecheck"], simfile);
  run("simfile suite", "npm", ["test"], simfile);

  const freshness = checkDistFreshness({ simfileDir: simfile });
  const freshnessProblems = freshness.flatMap(({ problems }) => problems);
  if (freshnessProblems.length > 0) {
    failures.push(...freshnessProblems);
    process.stdout.write("FAIL  dist freshness\n");
    for (const problem of freshnessProblems) process.stdout.write(`  - ${problem}\n`);
  } else {
    const counts = freshness.map(({ label, sources, pairs, allowedUnmappedOutputs }) =>
      `${label}: ${sources.length} sources / ${pairs.length} mapped, `
      + `${allowedUnmappedOutputs.length} allowed-unmapped`).join("; ");
    process.stdout.write(`PASS  dist freshness (${counts})\n`);
  }

  // These repos had no entry, letting Daimon stay red for days with a disarmed
  // honesty test nobody saw. At roughly 10s / 3s / 5s, their full suites are
  // cheap enough to gate instead of hand-picked boundary subsets.
  run("daimon suite", "npm", ["test"], daimon);
  run("moltnet suite", "go", ["test", "./..."], moltnet);
  run("stele suite", "npm", ["test"], stele);

  // Future expansion: parallel gates, per-repo timeouts, and CI wiring.

  // Mneme
  run("mneme boundary gate", "node", ["--import", "tsx", "--test", "src/boundary.test.ts"], mneme);

  if (failures.length > 0) {
    const details = failures.map((failure) => `  - ${failure}`).join("\n");
    process.stderr.write(`\nV FAILED (${failures.length}):\n${details}\n`);
    process.exit(1);
  }
  process.stdout.write("\nV PASSED: all boundary gates and typechecks green\n");
};

const isEntryPoint = (() => {
  if (!process.argv[1]) return false;
  const invokedPath = path.resolve(process.argv[1]);
  const modulePath = path.resolve(fileURLToPath(import.meta.url));
  try {
    return realpathSync(invokedPath) === realpathSync(modulePath);
  } catch {
    return invokedPath === modulePath;
  }
})();
if (isEntryPoint) {
  main();
}
