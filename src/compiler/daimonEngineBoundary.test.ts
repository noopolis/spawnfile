import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const engineIds = new Set(["agy", "codex", "grok"]);

/** Detect engine dispatch, not public auth-method IDs or frozen wire content. */
function engineBranches(source: string, embedded = false): string[] {
  const file = ts.createSourceFile("boundary.ts", source, ts.ScriptTarget.Latest, true);
  const bindings = new Map<string, ts.Expression>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) bindings.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(file);
  const resolves = (node: ts.Expression, seen = new Set<string>()): ts.Expression => {
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      const bound = bindings.get(node.text);
      if (bound) return resolves(bound, new Set([...seen, node.text]));
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return resolves(node.expression, seen);
    return node;
  };
  const engineSelector = (node: ts.Expression): boolean => {
    // Local aliases of agent.engine.kind retain the selector's provenance.
    if (ts.isIdentifier(node) && /engine/iu.test(node.text)) return true;
    const resolved = resolves(node);
    if (ts.isPropertyAccessExpression(resolved) && ["method", "provider", "auth"].includes(resolved.name.text)) return false;
    if (ts.isIdentifier(resolved)) return /engine/iu.test(resolved.text);
    if (ts.isPropertyAccessExpression(resolved)) return /engine/iu.test(resolved.name.text) || engineSelector(resolved.expression);
    if (ts.isElementAccessExpression(resolved)) return engineSelector(resolved.expression)
      || (ts.isStringLiteral(resolved.argumentExpression) && /engine/iu.test(resolved.argumentExpression.text));
    return ts.isCallExpression(resolved) && engineSelector(resolved.expression);
  };
  const hasEngineLiteral = (node: ts.Node): boolean => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return engineIds.has(node.text);
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && engineIds.has(node.name.text)) return true;
    return ts.forEachChild(node, child => hasEngineLiteral(child) || undefined) === true;
  };
  const findings: string[] = [];
  const visit = (node: ts.Node): void => {
    if (!embedded && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))) {
      // Rendered JavaScript and the auth-command shell guard are compiler code
      // too; a template literal must not hide the same engine dispatch.
      if (/engine/iu.test(node.text)) findings.push(...engineBranches(node.text, true));
      if (/\[\s*"\$2"\s+!?=\s+["']?(?:agy|codex|grok)["']?\s*\]/u.test(node.text)) findings.push(node.text);
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind)) {
      if ((engineSelector(node.left) && hasEngineLiteral(node.right)) || (engineSelector(node.right) && hasEngineLiteral(node.left))) findings.push(node.getText(file));
    }
    if (ts.isSwitchStatement(node) && engineSelector(node.expression)) {
      for (const clause of node.caseBlock.clauses) if (ts.isCaseClause(clause) && hasEngineLiteral(clause.expression)) findings.push(clause.expression.getText(file));
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ["includes", "has"].includes(node.expression.name.text) && node.arguments.some(engineSelector)
      && hasEngineLiteral(resolves(node.expression.expression))) findings.push(node.getText(file));
    if (ts.isElementAccessExpression(node) && engineSelector(node.argumentExpression)
      && hasEngineLiteral(resolves(node.expression))) findings.push(node.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

async function productionSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(target);
    return entry.name.endsWith(".ts") && !/\.(?:test|test-helper)\.ts$/u.test(entry.name) ? [target] : [];
  }))).flat();
}

describe("Daimon engine ownership boundary", () => {
  it("keeps compiler, auth, distribution and shared engine dispatch descriptor-driven", async () => {
    // Pi's engines and codex-exec's standalone subject belong to other runtimes.
    // Auth method/provider IDs, profile lifecycle and frozen wire content are
    // Spawnfile policy; selectors for those are deliberately not engine dispatch.
    const files = (await Promise.all(["compiler", "auth", "distribution", "shared"]
      .map(folder => productionSources(path.join(sourceRoot, folder))))).flat();
    expect(files.length).toBeGreaterThan(100);
    const findings = (await Promise.all(files.map(async file => engineBranches(await readFile(file, "utf8"))
      .map(branch => `${path.relative(sourceRoot, file)}: ${branch}`)))).flat();
    expect(findings, `Daimon engine dispatch boundary guarantee: ${JSON.stringify(findings)}`).toEqual([]);
  });

  it.each([
    'if (engine === "grok") provision();',
    'if ("codex" !== options.engine) refuse();',
    'const kind = agent.engine.kind; if (kind === "agy") stage();',
    'const selected = agent.engine; if (selected.kind === "grok") provision();',
    'switch (agent.engine.kind) { case "grok": provision(); }',
    'const allowed = ["agy", "codex", "grok"]; if (allowed.includes(engine)) stage();',
    'const allowed = new Set(["codex", "grok"]); if (allowed.has(input.engine)) stage();',
    'const actions = { codex: stage }; actions[engine]();',
    'const generated = `if (agent.engine.kind === "grok") provision();`;',
    'const shell = `if [ "$2" != agy ]; then exit 1; fi`;'
  ])("detects an injected engine branch: %s", source => {
    expect(engineBranches(source), "injected engine branch mutation").toHaveLength(1);
  });

  it("allows auth identities, legacy content, descriptor capabilities and other comparisons", () => {
    expect(engineBranches(`
      if (target.auth.method === "grok") validateProvider();
      if (record.kind !== "codex") rejectCredentialRequest();
      const launch = { engine: "grok" };
      type Engine = "codex" | "grok";
      if (descriptor.auth.staging === "portable-file") stage();
      if (engine === DAIMON_BROKER_ENGINE_ID) provision();
      if (getDaimonEngineDescriptor(engine)?.training.subject.isolation === "native-sandbox") sandbox();
    `)).toEqual([]);
  });
});

// Mutate a complete isolated production snapshot and run the real repository
// assertion. No concurrently running test ever sees changed working-tree files.
it.each([
  ["compiler", 'const engine = "fixture"; if (engine === "grok") throw Error();'],
  ["auth", 'const engines = ["agy", "codex", "grok"]; if (engines.includes(input.engine)) stage();']
])("rejects a real %s boundary mutation in an isolated copy", async (folder, mutation) => {
  const root = path.dirname(sourceRoot.replace(/\/$/u, ""));
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "spawnfile-engine-boundary-"));
  try {
    for (const area of ["compiler", "auth", "distribution", "shared"]) {
      for (const file of await productionSources(path.join(sourceRoot, area))) {
        const target = path.join(sandbox, "src", path.relative(sourceRoot, file));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, await readFile(file));
      }
    }
    const testFile = "src/compiler/daimonEngineBoundary.test.ts";
    await writeFile(path.join(sandbox, testFile), await readFile(new URL(import.meta.url)));
    for (const file of ["vitest.config.ts", "package.json"]) await writeFile(path.join(sandbox, file), await readFile(path.join(root, file)));
    await symlink(path.join(root, "node_modules"), path.join(sandbox, "node_modules"));
    await writeFile(path.join(sandbox, "src", folder!, "engineBoundaryMutation.ts"), mutation!);
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--coverage.enabled=false",
        "--maxWorkers=1", "--minWorkers=1", testFile, "-t", "keeps compiler, auth, distribution"], {
        cwd: sandbox, detached: true, env: { ...process.env, TYPESAFE_API_KEY: undefined }, stdio: ["ignore", "pipe", "pipe"]
      });
      let output = "", reaped = false;
      child.stdout.on("data", chunk => { output += String(chunk); });
      child.stderr.on("data", chunk => { output += String(chunk); });
      const timer = setTimeout(() => {
        if (!reaped && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
      }, 20_000);
      child.once("exit", () => { reaped = true; clearTimeout(timer); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", code => { clearTimeout(timer); resolve({ code, output }); });
    });
    expect(result.code, result.output).toBe(1);
    const report = JSON.parse(await readFile(path.join(sandbox, "coverage/vitest-results.json"), "utf8")) as {
      testResults: { assertionResults: { status: string; failureMessages: string[] }[] }[];
    };
    const failures = report.testResults.flatMap(suite => suite.assertionResults).filter(assertion => assertion.status === "failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]!.failureMessages.join("\n")).toContain("Daimon engine dispatch boundary guarantee");
    expect(failures[0]!.failureMessages.join("\n")).toContain("engineBoundaryMutation.ts");
  } finally { await rm(sandbox, { recursive: true, force: true }); }
}, 30_000);
