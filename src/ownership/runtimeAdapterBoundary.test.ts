import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const registration = "src/runtime/builtinAdapters.generated.ts";
const sharedContracts = new Set([
  "src/runtime/types.ts", "src/runtime/hostTypes.ts", "src/compiler/containerArtifactsTypes.ts"
]);

async function historicalExports(names: ReadonlySet<string>): Promise<Set<string>> {
  const edges = new Set<string>();
  for (const name of names) {
    const file = path.join(root, "src/runtime", name, "legacyExports.json");
    let raw: string;
    try { raw = await readFile(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const entry of JSON.parse(raw) as Array<{ surfaces: string[]; from: string }>) {
      for (const surface of entry.surfaces) {
        edges.add(`src/runtime/legacy${surface}.generated.ts:src/runtime/${name}/${entry.from}.js`);
      }
    }
  }
  return edges;
}

function isShippedSource(file: string): boolean {
  return /\.[cm]?[jt]sx?$/u.test(file)
    && !file.startsWith("src/e2e/")
    && !/\.(?:test|spec)(?:[.-]|$)|(?:^|\/)(?:__tests__|test-support)\//u.test(file);
}

async function sourceFiles(): Promise<string[]> {
  const entries = await readdir(path.join(root, "src"), { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => (
    path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/")
  )).filter(isShippedSource).sort();
}

function moduleSpecifier(node: ts.Node): ts.Expression | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) return node.argument.literal;
  if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
    || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
    return node.arguments[0];
  }
  return undefined;
}

function owner(file: string, names: ReadonlySet<string>): string | undefined {
  const [src, runtime, name] = file.split("/");
  return src === "src" && runtime === "runtime" && name && names.has(name) ? name : undefined;
}

const equality = new Set([
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken
]);

function isNativeDispatch(literal: ts.StringLiteralLike): boolean {
  const parent = literal.parent;
  if (ts.isCaseClause(parent)) return parent.expression === literal;
  if (ts.isBinaryExpression(parent)) return equality.has(parent.operatorToken.kind);
  if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression)) {
    return ["getRuntimeAdapter", "hasRuntimeAdapter", "getRegisteredRuntime"].includes(parent.expression.text);
  }
  if (ts.isArrayLiteralExpression(parent) && ts.isPropertyAccessExpression(parent.parent)) {
    return ["includes", "indexOf"].includes(parent.parent.name.text);
  }
  if (ts.isArrayLiteralExpression(parent) && parent.elements[0] === literal
    && ts.isArrayLiteralExpression(parent.parent)) {
    const constructor = parent.parent.parent;
    return ts.isNewExpression(constructor) && ts.isIdentifier(constructor.expression)
      && constructor.expression.text === "Map";
  }
  return false;
}

function isCausalProducerCheck(file: string, literal: ts.StringLiteralLike, source: ts.SourceFile): boolean {
  // These are versioned ledger producer identities shared with the reconciler.
  if (!["src/ledger/principal.ts", "src/ledger/conformance.ts"].includes(file)) return false;
  const comparison = literal.parent;
  return literal.text === "daimon" && ts.isBinaryExpression(comparison)
    && comparison.left.getText(source) === "event.emitter.system";
}

function violations(
  file: string, body: string, names: ReadonlySet<string>, historical: ReadonlySet<string> = new Set()
): string[] {
  const source = ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true);
  const current = owner(file, names);
  const findings: string[] = [];
  const report = (node: ts.Node, message: string): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push(`${file}:${line + 1} ${message}`);
  };

  if (!current && [...names].some((name) => path.posix.basename(file).toLowerCase().includes(name))) {
    findings.push(`${file} is a native runtime module outside its adapter`);
  }
  function visit(node: ts.Node): void {
    const specifier = moduleSpecifier(node);
    if (specifier && ts.isStringLiteralLike(specifier)) {
      const target = specifier.text.startsWith(".")
        ? path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier.text))
        : specifier.text.replace(/^spawnfile\/(?:src|dist)\//u, "src/");
      const imported = owner(target, names);
      const bundledEntry = file === registration && ts.isImportDeclaration(node)
        && target === `src/runtime/${imported}/registration.js`;
      const legacyEntry = ts.isExportDeclaration(node) && historical.has(`${file}:${target}`);
      if (imported && imported !== current && !bundledEntry && !legacyEntry) {
        report(specifier, `imports ${imported} implementation ${specifier.text}`);
      }
    }
    if (sharedContracts.has(file) && ts.isPropertySignature(node) && ts.isIdentifier(node.name)) {
      const field = node.name.text.toLowerCase();
      if ([...names, "grok", "codex"].some((name) => field.includes(name))) {
        report(node.name, `shared contract exposes a native property "${node.name.text}"`);
      }
    }
    if (ts.isStringLiteralLike(node) && names.has(node.text) && node.text !== current
      && isNativeDispatch(node) && !isCausalProducerCheck(file, node, source)) {
      report(node, `selects native behavior by name "${node.text}"`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return findings;
}

test("only adapter registration imports native implementations, and core dispatches through capabilities", async () => {
  const files = await sourceFiles();
  const names = new Set(files.flatMap((file) => {
    const match = /^src\/runtime\/([^/]+)\/adapter\.ts$/u.exec(file);
    return match ? [match[1]!] : [];
  }));
  expect(names.size).toBeGreaterThan(0);
  const historical = await historicalExports(names);
  const results = await Promise.all(files.map(async (file) => (
    violations(file, await readFile(path.join(root, file), "utf8"), names, historical)
  )));
  expect(results.flat()).toEqual([]);
});

test("the boundary catches static, dynamic and type imports and name dispatch for a new harness", () => {
  const names = new Set(["example"]);
  for (const body of [
    'export { native } from "../runtime/example/native.js";',
    'await import("../runtime/example/native.js");',
    'type Native = import("../runtime/example/native.js").Native;',
    'import { native } from "spawnfile/dist/runtime/example/native.js";',
    'if (runtime.name === "example") start();',
    'switch (runtime.name) { case "example": start(); }',
    'if (["example"].includes(runtime.name)) start();',
    'const install = new Map([["example", recipe]]);',
    'getRuntimeAdapter("example");'
  ]) {
    expect(violations("src/compiler/file.ts", body, names)).toHaveLength(1);
  }
  expect(violations("src/compiler/exampleStartup.ts", "", names)).toHaveLength(1);
  expect(violations("src/compiler/file.ts", 'getRuntimeAdapter(runtime.name);', names)).toEqual([]);
  expect(violations("src/runtime/example/adapter.ts", 'import { start } from "./native.js";', names)).toEqual([]);
  expect(violations(registration, 'import { adapter } from "./example/registration.js";', names)).toEqual([]);
  expect(violations(registration, 'import { native } from "./example/private.js";', names)).toHaveLength(1);
  expect(violations("src/runtime/types.ts", "interface Target { exampleSetting: number }", names)).toHaveLength(1);
  expect(violations("src/runtime/types.ts", "interface Target { grokModelByNodeId: string }", names)).toHaveLength(1);
});
