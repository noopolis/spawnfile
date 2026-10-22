import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint, type Linter } from 'eslint';
import ts from 'typescript';
import { expect, test } from 'vitest';
import { trainingLintConfig } from '../../tooling/training/eslint/index.js';
import { canonicalPath, importTarget, inside } from '../../tooling/training/eslint/index.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const trainingRoot = path.join(root, 'src/training');

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(filename) : Promise.resolve(/\.[cm]?tsx?$/.test(entry.name) ? [filename] : []);
  }));
  return files.flat();
}

function importSpecifiers(source: string): string[] {
  const parsed = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  const imports = ts.preProcessFile(source, true, true);
  const specifiers = [...imports.importedFiles, ...imports.referencedFiles].map((item) => item.fileName);
  const constants = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
      ts.isStringLiteral(node.initializer) && ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0) constants.set(node.name.text, node.initializer.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      const argument = node.arguments[0];
      if (argument && ts.isIdentifier(argument) && constants.has(argument.text)) specifiers.push(constants.get(argument.text)!);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return specifiers;
}

function boundaryViolations(filename: string, source: string): string[] {
  const fromTraining = inside(trainingRoot, filename);
  // TODO packet 1b: move adapters to their runtime owners, then remove this sole exemption.
  if (fromTraining && inside(path.join(trainingRoot, 'adapters'), filename)) return [];
  const forbidden = fromTraining ? ['src/runtime', 'src/compiler'] : ['src/training'];
  return importSpecifiers(source).filter((specifier) => {
    let target = specifier;
    if (target.startsWith('file:')) target = fileURLToPath(target);
    if (!target.startsWith('.') && !path.isAbsolute(target)) return false;
    const resolved = importTarget(filename, target);
    return forbidden.some((directory) => inside(canonicalPath(path.join(root, directory)), resolved));
  });
}

test('training retains its imported structural and public module gates', async () => {
  const eslint = new ESLint({ cwd: root, overrideConfigFile: true,
    overrideConfig: trainingLintConfig as unknown as Linter.Config[] });
  const results = await eslint.lintFiles(['src/training/**/*.ts', 'tooling/training/**/*.ts']);
  expect(results.flatMap((result) => result.messages.filter((message) => message.severity === 2)
    .map((message) => `${path.relative(root, result.filePath)}:${message.line}: ${message.ruleId}: ${message.message}`))).toEqual([]);
}, 120_000);

test('training stays runtime neutral and Spawnfile continues to delegate externally', async () => {
  const files = (await sourceFiles(path.join(root, 'src'))).filter((filename) => !filename.endsWith('.test.ts'));
  const violations = await Promise.all(files.map(async (filename) => boundaryViolations(filename, await readFile(filename, 'utf8'))
    .map((specifier) => `${path.relative(root, filename)} imports ${specifier}`)));
  expect(violations.flat()).toEqual([]);
});

test.each([
  ['src/training/evaluation/check.ts', "import '../../runtime/index.js';"],
  ['src/training/evaluation/check.ts', "export * from '../../compiler/index.js';"],
  ['src/training/evaluation/check.ts', "await import('../../runtime/index.js');"],
  ['src/training/evaluation/check.ts', "const target = '../../compiler/index.js'; await import(target);"],
  ['src/training/evaluation/check.ts', "type Module = import('../../compiler/index.js');"],
  ['src/training/evaluation/check.ts', "import runtime = require('../../runtime/index.js');"],
  ['src/training/evaluation/check.ts', "/// <reference path='../../runtime/index.ts' />"],
  ['src/cli/check.ts', "import '../training/index.js';"],
])('rejects a forbidden dependency from %s: %s', (filename, source) => {
  expect(boundaryViolations(path.join(root, filename), source)).not.toEqual([]);
});

test('the adapters exemption is narrow and legitimate training imports remain valid', () => {
  expect(boundaryViolations(path.join(root, 'src/training/adapters/runtime.ts'), "import '../../runtime/index.js';")).toEqual([]);
  expect(boundaryViolations(path.join(root, 'src/training/adapters-extra/runtime.ts'), "import '../../runtime/index.js';")).not.toEqual([]);
  expect(boundaryViolations(path.join(root, 'src/training/evaluation/check.ts'), "import '../contracts/index.js';")).toEqual([]);
  expect(boundaryViolations(path.join(root, 'src/cli/check.ts'), "import '../compiler/training/index.js';")).toEqual([]);
});
