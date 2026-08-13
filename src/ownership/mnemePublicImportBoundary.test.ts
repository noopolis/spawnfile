import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceRoot = path.join(repositoryRoot, "src");
const boundaryTestPath = path.join(sourceRoot, "ownership", "mnemePublicImportBoundary.test.ts");

type PrivateMnemeImportKind =
  | "package-source-subpath"
  | "repository-source-reach-through";

type ModuleSpecifierOccurrence = {
  specifier: string;
};

type PrivateMnemeImportViolation = {
  file: string;
  classification: PrivateMnemeImportKind;
  specifier: string;
};

function normalizeModuleSpecifier(value: string): string {
  return value.replace(/\\/g, "/");
}

function classifyPrivateMnemeSpecifier(value: string): PrivateMnemeImportKind | null {
  const normalized = normalizeModuleSpecifier(value);
  const segments = normalized.split("/");

  for (let index = 0; index <= segments.length - 3; index += 1) {
    if (
      segments[index] === "ecosystem"
      && segments[index + 1] === "mneme"
      && segments[index + 2] === "src"
    ) {
      return "repository-source-reach-through";
    }
  }

  if (
    normalized === "@noopolis/mneme/src"
    || normalized.startsWith("@noopolis/mneme/src/")
  ) {
    return "package-source-subpath";
  }

  return null;
}

function collectModuleSpecifiers(sourceFile: ts.SourceFile): ModuleSpecifierOccurrence[] {
  const occurrences: ModuleSpecifierOccurrence[] = [];

  function collect(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      occurrences.push({ specifier: node.moduleSpecifier.text });
    }

    if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const [argument] = node.arguments;
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";

      if ((isDynamicImport || isRequire) && ts.isStringLiteral(argument)) {
        occurrences.push({ specifier: argument.text });
      }
    }

    ts.forEachChild(node, collect);
  }

  collect(sourceFile);
  return occurrences;
}

async function scanSourceFile(filePath: string): Promise<PrivateMnemeImportViolation[]> {
  const source = await readFile(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS
  );

  return collectModuleSpecifiers(sourceFile).flatMap(({ specifier }) => {
    const classification = classifyPrivateMnemeSpecifier(specifier);
    if (!classification) {
      return [];
    }

    return [{
      file: path.relative(repositoryRoot, filePath),
      classification,
      specifier
    }];
  });
}

async function allSourceTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return allSourceTypeScriptFiles(entryPath);
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) {
      return [];
    }
    return [entryPath];
  }));
  return nested.flat();
}

async function scanSourceTree(): Promise<PrivateMnemeImportViolation[]> {
  const files = await allSourceTypeScriptFiles(sourceRoot);
  const violations = await Promise.all(
    files
      .map((filePath) => path.resolve(filePath))
      .filter((filePath) => filePath !== path.resolve(boundaryTestPath))
      .map((filePath) => scanSourceFile(filePath))
  );
  return violations.flat();
}

function scanSyntheticSource(source: string): PrivateMnemeImportViolation[] {
  const sourceFile = ts.createSourceFile(
    "synthetic.ts",
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS
  );

  return collectModuleSpecifiers(sourceFile).flatMap(({ specifier }) => {
    const classification = classifyPrivateMnemeSpecifier(specifier);
    if (!classification) {
      return [];
    }
    return [{ file: "synthetic.ts", classification, specifier }];
  });
}

function resolveWithNode(specifier: string): SpawnSyncReturns<string> {
  const resolverSource = `
    const specifier = process.argv[1];
    try {
      process.stdout.write(import.meta.resolve(specifier));
    } catch (error) {
      process.stderr.write(String(error.code));
      process.exitCode = 1;
    }
  `;

  return spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", resolverSource, specifier],
    { cwd: repositoryRoot, encoding: "utf8" }
  );
}

describe("Mneme public import boundary", () => {
  it("keeps private Mneme source imports out of root production and test modules", async () => {
    expect(await scanSourceTree()).toEqual([]);
  });

  it.each([
    {
      source: `import { createMemoryRuntime } from "../../../ecosystem/mneme/src/runtime/runtime.js";`,
      classification: "repository-source-reach-through",
      specifier: "../../../ecosystem/mneme/src/runtime/runtime.js"
    },
    {
      source: `import type { MemoryRuntime } from "../../../ecosystem/mneme/src/contract/types.js";`,
      classification: "repository-source-reach-through",
      specifier: "../../../ecosystem/mneme/src/contract/types.js"
    },
    {
      source: `export { readMemoryContext } from "../../../ecosystem/mneme/src/identity/scope.js";`,
      classification: "repository-source-reach-through",
      specifier: "../../../ecosystem/mneme/src/identity/scope.js"
    },
    {
      source: `const runtime = await import("@noopolis/mneme/src/runtime/runtime.js");`,
      classification: "package-source-subpath",
      specifier: "@noopolis/mneme/src/runtime/runtime.js"
    },
    {
      source: String.raw`const runtime = require("..\\..\\..\\ecosystem\\mneme\\src\\runtime\\runtime.js");`,
      classification: "repository-source-reach-through",
      specifier: String.raw`..\..\..\ecosystem\mneme\src\runtime\runtime.js`
    }
  ] satisfies Array<{
    source: string;
    classification: PrivateMnemeImportKind;
    specifier: string;
  }>)("rejects private Mneme import: $specifier", ({ source, classification, specifier }) => {
    expect(scanSyntheticSource(source)).toEqual([{
      file: "synthetic.ts",
      classification,
      specifier
    }]);
  });

  it.each([
    `import { createMemoryRuntime, type MemoryRuntime } from "@noopolis/mneme";`,
    `import { createMnemeMcpServer } from "@noopolis/mneme/mcp";`,
    `// import { createMemoryRuntime } from "../../../ecosystem/mneme/src/runtime/runtime.js";`
  ])("allows public Mneme imports and documentation comments", (source) => {
    expect(scanSyntheticSource(source)).toEqual([]);
  });

  it("enforces Mneme's declared package exports", () => {
    const publicResolution = resolveWithNode("@noopolis/mneme");
    expect(publicResolution.status).toBe(0);
    expect(publicResolution.stdout).toMatch(/\/dist\/index\.js$/u);

    const privateResolution = resolveWithNode("@noopolis/mneme/src/runtime/runtime.js");
    expect(privateResolution.status).not.toBe(0);
    expect(privateResolution.stderr).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
  });
});
