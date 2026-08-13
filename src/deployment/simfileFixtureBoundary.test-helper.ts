import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import * as ts from "typescript";

export type SimfileFixtureViolation = {
  file: string;
  classification: "simfile-scenario-direct-literal" | "simfile-scenario-path-join" | "simfile-scenario-path-resolve";
  matchedPath: string;
};

type PathAliases = {
  namespaceAliases: Set<string>;
  functionAliases: Map<string, "join" | "resolve">;
};

const normalize = (value: string): string => value.replace(/\\/g, "/");

const fixturePath = (value: string): string | null => {
  const normalized = normalize(value);
  const index = normalized.toLowerCase().indexOf("ecosystem/simfile/fixtures");
  if (index < 0 || (index > 0 && !/[\\/]/u.test(normalized[index - 1]!))) return null;
  return normalized.slice(index);
};

const aliasesFor = (sourceFile: ts.SourceFile): PathAliases => {
  const namespaceAliases = new Set<string>();
  const functionAliases = new Map<string, "join" | "resolve">();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || !["node:path", "path"].includes(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) namespaceAliases.add(clause.name.text);
    if (!clause.namedBindings) continue;
    if (ts.isNamespaceImport(clause.namedBindings)) namespaceAliases.add(clause.namedBindings.name.text);
    if (ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (imported === "join" || imported === "resolve") functionAliases.set(element.name.text, imported);
      }
    }
  }
  return { namespaceAliases, functionAliases };
};

const pathCallViolations = (
  node: ts.CallExpression,
  aliases: PathAliases,
  sourceFile: ts.SourceFile
): SimfileFixtureViolation[] => {
  const callee = node.expression;
  let kind: "join" | "resolve" | null = null;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
    && aliases.namespaceAliases.has(callee.expression.text) && ["join", "resolve"].includes(callee.name.text)) {
    kind = callee.name.text as "join" | "resolve";
  } else if (ts.isIdentifier(callee)) {
    kind = aliases.functionAliases.get(callee.text) ?? null;
  }
  if (!kind) return [];
  const segments = node.arguments.map((argument) =>
    ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument) ? normalize(argument.text) : null);
  const start = segments.findIndex((segment, index) =>
    index <= segments.length - 3 && segment === "ecosystem" && segments[index + 1] === "simfile" && segments[index + 2] === "fixtures");
  if (start < 0) return [];
  const matchedSegments: string[] = [];
  for (const segment of segments.slice(start)) {
    if (segment === null) break;
    matchedSegments.push(segment);
  }
  return [{
    file: path.relative(process.cwd(), sourceFile.fileName),
    classification: kind === "join" ? "simfile-scenario-path-join" : "simfile-scenario-path-resolve",
    matchedPath: matchedSegments.join("/")
  }];
};

export const scanSimfileFixtureSource = (text: string, file = "synthetic.ts"): SimfileFixtureViolation[] => {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const aliases = aliasesFor(sourceFile);
  const violations: SimfileFixtureViolation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const matchedPath = fixturePath(node.text);
      if (matchedPath) violations.push({ file, classification: "simfile-scenario-direct-literal", matchedPath });
    }
    if (ts.isCallExpression(node)) violations.push(...pathCallViolations(node, aliases, sourceFile));
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
};

export const scanSimfileFixtureFile = async (file: string): Promise<SimfileFixtureViolation[]> =>
  scanSimfileFixtureSource(await readFile(file, "utf8"), file);

const typescriptFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(file);
    return entry.isFile() && entry.name.endsWith(".ts") ? [file] : [];
  }));
  return nested.flat();
};

export const scanSimfileFixtureTree = async (
  repositoryRoot: string
): Promise<SimfileFixtureViolation[]> => {
  const excluded = new Set([
    path.resolve(repositoryRoot, "src/deployment/providerRuntimeBoundary.test.ts"),
    path.resolve(repositoryRoot, "src/deployment/simfileFixtureBoundary.test-helper.ts")
  ]);
  const files = (await typescriptFiles(path.join(repositoryRoot, "src")))
    .map((file) => path.resolve(file))
    .filter((file) => !excluded.has(file));
  return (await Promise.all(files.map(scanSimfileFixtureFile))).flat();
};
