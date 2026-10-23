#!/usr/bin/env node
/** Read only static descriptor data from the exact Daimon Git pin; never execute Daimon code. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as ts from "typescript";
import { parse } from "yaml";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
export type DescriptorArtifacts = { json: string; digest: string; module: string };
export const DESCRIPTOR_MIRROR_VERSION = "noopolis.spawnfile.daimon-engine-descriptors.v1";
const descriptorSource = "src/engines/descriptors.ts";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const subprocessEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  return env;
};

export const readPinnedDaimonCommit = (registry: string): string => {
  const value: unknown = parse(registry);
  const ref = object(value) && object(value.runtimes) && object(value.runtimes.daimon) ? value.runtimes.daimon.ref : undefined;
  if (typeof ref !== "string" || !/^[a-f0-9]{40}$/u.test(ref)) throw new Error("runtimes.yaml requires an exact full Daimon commit pin");
  return ref;
};

/** The expression evaluator deliberately has no function, process, filesystem or runtime-handler access. */
export const readStaticEngineDescriptors = (readSource: (filename: string) => string): JsonObject => {
  const modules = new Map<string, JsonObject>();
  const loading = new Set<string>();
  const load = (filename: string): JsonObject => {
    const cached = modules.get(filename);
    if (cached) return cached;
    if (loading.has(filename)) throw new Error(`cyclic static descriptor import: ${filename}`);
    loading.add(filename);
    const source = ts.createSourceFile(filename, readSource(filename), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const bindings: JsonObject = Object.create(null) as JsonObject;
    const exported: JsonObject = Object.create(null) as JsonObject;
    const fail = (node: ts.Node): never => { throw new Error(`non-static Daimon descriptor syntax in ${filename}: ${node.getText(source)}`); };
    const evaluate = (node: ts.Expression): Json => {
      if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return evaluate(node.expression);
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
      if (ts.isNumericLiteral(node)) return Number(node.text);
      if (node.kind === ts.SyntaxKind.NullKeyword) return null;
      if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
      if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
      if (ts.isIdentifier(node) && Object.hasOwn(bindings, node.text)) return bindings[node.text]!;
      if (ts.isBinaryExpression(node)) {
        const left = evaluate(node.left);
        const right = evaluate(node.right);
        if (typeof left !== "number" || typeof right !== "number") return fail(node);
        switch (node.operatorToken.kind) {
          case ts.SyntaxKind.PlusToken: return left + right;
          case ts.SyntaxKind.MinusToken: return left - right;
          case ts.SyntaxKind.AsteriskToken: return left * right;
          case ts.SyntaxKind.SlashToken: if (right !== 0) return left / right;
        }
        return fail(node);
      }
      if (ts.isArrayLiteralExpression(node)) return node.elements.map((element) => evaluate(element));
      if (ts.isObjectLiteralExpression(node)) {
        const value: JsonObject = Object.create(null) as JsonObject;
        for (const property of node.properties) {
          if (!ts.isPropertyAssignment(property)) return fail(property);
          const name = property.name;
          if (!ts.isIdentifier(name) && !ts.isStringLiteral(name) && !ts.isNumericLiteral(name)) return fail(name);
          value[name.text] = evaluate(property.initializer);
        }
        return value;
      }
      if (ts.isPropertyAccessExpression(node)) {
        const value = evaluate(node.expression);
        if (!object(value) || !Object.hasOwn(value, node.name.text)) return fail(node);
        return value[node.name.text]!;
      }
      if (ts.isTemplateExpression(node)) {
        let value = node.head.text;
        for (const span of node.templateSpans) {
          const part = evaluate(span.expression);
          if (part !== null && typeof part === "object") return fail(span.expression);
          value += String(part) + span.literal.text;
        }
        return value;
      }
      // Object.freeze is a static data annotation; it cannot invoke upstream code.
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Object"
        && node.expression.name.text === "freeze" && node.arguments.length === 1) return evaluate(node.arguments[0]!);
      return fail(node);
    };
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        if (!ts.isStringLiteral(statement.moduleSpecifier)) return fail(statement);
        const specifier = statement.moduleSpecifier.text;
        const imports = statement.importClause?.namedBindings;
        if (!specifier.startsWith(".") || !specifier.endsWith(".js") || !imports || !ts.isNamedImports(imports)) return fail(statement);
        const importedPath = path.posix.normalize(path.posix.join(path.posix.dirname(filename), specifier.replace(/\.js$/u, ".ts")));
        if (!importedPath.startsWith("src/engines/")) return fail(statement);
        const imported = load(importedPath);
        for (const item of imports.elements) {
          const key = (item.propertyName ?? item.name).text;
          if (!Object.hasOwn(imported, key)) return fail(item);
          bindings[item.name.text] = imported[key]!;
        }
      } else if (ts.isVariableStatement(statement)) {
        if (!(statement.declarationList.flags & ts.NodeFlags.Const)) return fail(statement);
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return fail(declaration);
          const value = evaluate(declaration.initializer);
          bindings[declaration.name.text] = value;
          if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) exported[declaration.name.text] = value;
        }
      } else if (!ts.isTypeAliasDeclaration(statement) && !ts.isInterfaceDeclaration(statement) && !ts.isEmptyStatement(statement)) {
        return fail(statement);
      }
    }
    loading.delete(filename);
    modules.set(filename, exported);
    return exported;
  };
  const engines = load(descriptorSource).ENGINE_DESCRIPTORS;
  if (!object(engines) || Object.keys(engines).length === 0) throw new Error("Daimon must export non-empty ENGINE_DESCRIPTORS");
  for (const [id, descriptor] of Object.entries(engines)) {
    if (!object(descriptor) || descriptor.id !== id) throw new Error(`Daimon descriptor key/id mismatch: ${id}`);
  }
  return engines;
};

const sorted = (value: Json): Json => Array.isArray(value) ? value.map(sorted) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key]!)])) : value;

export const renderEngineDescriptorArtifacts = (sourceCommit: string, engines: JsonObject): DescriptorArtifacts => {
  const ordered = sorted(engines);
  const json = JSON.stringify({ version: DESCRIPTOR_MIRROR_VERSION, sourceCommit, engines: ordered }, null, 2) + "\n";
  const digest = `sha256:${createHash("sha256").update(json).digest("hex")}\n`;
  const module = [
    "/* v8 ignore file -- generated data module */",
    "// Generated by scripts/generate-daimon-engine-descriptors.ts from pinned Daimon static descriptors. Do not edit.",
    `export const DAIMON_ENGINE_DESCRIPTOR_SOURCE_COMMIT = ${JSON.stringify(sourceCommit)} as const;`,
    `export const DAIMON_V5_ENGINE_DESCRIPTORS = ${JSON.stringify(ordered)} as const;`,
    ""
  ].join("\n");
  return { json, digest, module };
};

export const generateEngineDescriptorArtifacts = (sourceDirectory: string, sourceCommit: string): DescriptorArtifacts => {
  if (!path.isAbsolute(sourceDirectory)) throw new Error("Daimon source directory must be absolute");
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new Error("Daimon descriptor generation requires an exact full commit pin");
  const engines = readStaticEngineDescriptors((filename) => execFileSync("git", ["-C", sourceDirectory, "show", `${sourceCommit}:${filename}`], {
    encoding: "utf8", env: subprocessEnv(), maxBuffer: 2 * 1024 * 1024
  }));
  return renderEngineDescriptorArtifacts(sourceCommit, engines);
};

export const verifyEngineDescriptorArtifacts = (artifacts: DescriptorArtifacts, directory: string): void => {
  const drifted = artifactFiles(artifacts).filter(([filename, bytes]) => readFileSync(path.join(directory, filename), "utf8") !== bytes);
  if (drifted.length > 0) throw new Error(`vendored Daimon engine descriptors drifted: ${drifted.map(([filename]) => filename).join(", ")}`);
};

const artifactFiles = (artifacts: DescriptorArtifacts): [string, string][] => [
  ["engine-descriptors.json", artifacts.json], ["engine-descriptors.sha256", artifacts.digest], ["engineDescriptors.generated.ts", artifacts.module]
];

const main = (): void => {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) throw new Error("usage: generate-daimon-engine-descriptors.ts [--check]");
  const sourceDirectory = process.env.SPAWNFILE_DAIMON_SOURCE_DIR?.trim() || path.resolve(repoRoot, "..", "daimon");
  const sourceCommit = readPinnedDaimonCommit(readFileSync(path.join(repoRoot, "runtimes.yaml"), "utf8"));
  const artifacts = generateEngineDescriptorArtifacts(sourceDirectory, sourceCommit);
  const directory = path.join(repoRoot, "src/runtime/daimon");
  if (args[0] === "--check") verifyEngineDescriptorArtifacts(artifacts, directory);
  else for (const [filename, bytes] of artifactFiles(artifacts)) writeFileSync(path.join(directory, filename), bytes);
  process.stdout.write(`Daimon engine descriptor mirror ${args[0] === "--check" ? "matches" : "generated from"} ${sourceCommit} ${artifacts.digest.trim()}\n`);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try { main(); } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
