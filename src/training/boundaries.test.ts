import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint, type Linter } from 'eslint';
import ts from 'typescript';
import { expect, test, vi } from 'vitest';
import { trainingLintConfig } from '../../tooling/training/eslint/index.js';
import { canonicalPath, importTarget, inside } from '../../tooling/training/eslint/index.js';

const root = canonicalPath(fileURLToPath(new URL('../../', import.meta.url)));
const trainingRoot = path.join(root, 'src/training');
const owners = {
  training: canonicalPath(trainingRoot),
  runtime: canonicalPath(path.join(root, 'src/runtime')),
  compiler: canonicalPath(path.join(root, 'src/compiler')),
};
const runtimePackage = ['@noopolis', 'daimon'].join('/');
// Retain the training project's deadlines when this file runs in the serial lane.
vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

async function sourceFiles(directory: string, typescriptOnly = true): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const filename = path.join(directory, entry.name);
    if (['.venv', '__pycache__', '.pytest_cache', 'node_modules', '.coverage', 'htmlcov'].includes(entry.name)) return Promise.resolve([]);
    return entry.isDirectory() ? sourceFiles(filename, typescriptOnly) : Promise.resolve(entry.isFile() && (!typescriptOnly || /\.[cm]?tsx?$/.test(entry.name)) ? [filename] : []);
  }));
  return files.flat();
}

// The preprocessor already finds literal imports. Only omit the AST when every
// raw import/require word is accounted for. Comments and strings overcount, so
// ambiguous syntax still takes the full parser path. Ignore export-only entries
// when accounting for words; AMD and ambient modules conservatively use the AST.
function needsSyntaxTree(source: string, imports: ts.PreProcessedFileInfo, fromTraining: boolean): boolean {
  if (/\b(?:define|declare)\b|\\u/u.test(source)) return true;
  if (fromTraining && (source.includes('`') || source.includes('\\') || source.includes(runtimePackage))) return true;
  const words = source.match(/\b(?:import|require)\b/gu)?.length ?? 0;
  // A leading literal can still be part of a computed import expression.
  // Core's stricter computed-import rule always inspects the full expression.
  if (fromTraining && words > 0) return true;
  if (words === 0) return false;
  const literalImports = /\bexport\b/u.test(source)
    ? ts.preProcessFile(source.replace(/\bexport\b/gu, '      '), true, true).importedFiles.length
    : imports.importedFiles.length;
  return words > literalImports;
}

function importSpecifiers(imports: ts.PreProcessedFileInfo, parsed?: ts.SourceFile, violations?: string[]): { specifier: string; typeOnly: boolean }[] {
  const specifiers = [...imports.importedFiles, ...imports.referencedFiles].map(item => ({
    specifier: item.fileName,
    typeOnly: parsed?.statements.some(statement => ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly === true &&
      statement.moduleSpecifier.getStart(parsed) <= item.pos && statement.moduleSpecifier.end >= item.end) ?? false,
  }));
  if (!parsed) return specifiers;
  const constants = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (violations) {
      if (ts.isStringLiteralLike(node) && node.text.includes(runtimePackage)) violations.push('runtime package literal');
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0]))) violations.push('computed dynamic import');
    }
    if (ts.isVariableDeclarationList(node)) {
      for (const declaration of node.declarations) {
        if ((node.flags & ts.NodeFlags.Const) !== 0 && ts.isIdentifier(declaration.name) &&
          declaration.initializer && ts.isStringLiteral(declaration.initializer)) {
          constants.set(declaration.name.text, declaration.initializer.text);
        }
        visit(declaration);
      }
      return;
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      const argument = node.arguments[0];
      if (argument && ts.isIdentifier(argument) && constants.has(argument.text)) specifiers.push({ specifier: constants.get(argument.text)!, typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return specifiers;
}

function boundaryViolations(filename: string, source: string, resolve = importTarget): string[] {
  const fromTraining = inside(trainingRoot, filename);
  const relative = path.relative(root, filename).split(path.sep).join('/');
  // Only the composition entry points and their adjacent tests may reach across owners.
  const integration = /^src\/runtime\/[^/]+\/training\//u.test(relative) ||
    /^src\/runtime\/training(?:Subjects|Cli)(?:\.test)?\.ts$/u.test(relative);
  const forbidden = fromTraining ? [owners.runtime, owners.compiler] : integration ? [] : [owners.training];
  if (forbidden.length === 0) return [];
  const violations: string[] = [];
  const imports = ts.preProcessFile(source, true, true);
  const parsed = relative === 'src/runtime/registry.ts' || needsSyntaxTree(source, imports, fromTraining)
    ? ts.createSourceFile(filename, source, { languageVersion: ts.ScriptTarget.Latest,
      jsDocParsingMode: ts.JSDocParsingMode.ParseNone }, false) : undefined;
  const specifiers = importSpecifiers(imports, parsed, fromTraining ? violations : undefined);
  return [...violations, ...specifiers.filter(({ specifier, typeOnly }) => {
    if (relative === 'src/runtime/registry.ts' && typeOnly) return false;
    let target = specifier;
    if (target.startsWith('file:')) target = fileURLToPath(target);
    if (!target.startsWith('.') && !path.isAbsolute(target)) return false;
    const resolved = resolve(filename, target);
    return forbidden.some((directory) => inside(directory, resolved));
  }).map(({ specifier }) => specifier)];
}

test('training retains its imported structural and public module gates', async () => {
  const eslint = new ESLint({ cwd: root, overrideConfigFile: true,
    overrideConfig: trainingLintConfig as unknown as Linter.Config[] });
  const results = await eslint.lintFiles(['src/training/**/*.ts', 'src/runtime/daimon/training/**/*.ts', 'src/runtime/codex-exec/training/**/*.ts', 'tooling/training/**/*.ts']);
  expect(results.flatMap((result) => result.messages.filter((message) => message.severity === 2)
    .map((message) => `${path.relative(root, result.filePath)}:${message.line}: ${message.ruleId}: ${message.message}`))).toEqual([]);
}, 120_000);

test('training stays runtime neutral through scoped runtime composition', async () => {
  const files = (await sourceFiles(path.join(root, 'src')));
  // This read-only inventory shares many imports. Resolve each target canonically
  // once for this scan, without retaining stale paths between tests or file edits.
  const targets = new Map<string, string>();
  const resolve: typeof importTarget = (filename, specifier) => {
    const key = path.resolve(path.dirname(filename), specifier);
    const cached = targets.get(key);
    if (cached !== undefined) return cached;
    const target = importTarget(filename, specifier);
    targets.set(key, target);
    return target;
  };
  const violations = await Promise.all(files.map(async (filename) => boundaryViolations(filename, await readFile(filename, 'utf8'), resolve)
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
  ['src/cli/check.ts', "const first = 'node:fs', target = '../training/index.js'; await import(target);"],
  ['src/cli/check.ts', "const target = '../training/index.js'; requ\\u0069re(target);"],
  ['src/cli/check.ts', "export { thing } from 'node:fs'; const target = '../training/index.js'; await import(target);"],
  ['src/compiler/runtime/check.ts', "import '../../training/index.js';"],
  ['src/runtime/common.ts', "import '../training/index.js';"],
  ['src/runtime/daimon/adapter.ts', "import '../../training/index.js';"],
  ['src/runtime/pi/adapter.ts', "export * from '../../training/index.js';"],
  ['src/runtime/codex-exec/training-extra/check.ts', "import '../../../training/index.js';"],
  ['src/runtime/daimon/other/training/check.ts', "import '../../../../training/index.js';"],
  ['src/runtime/trainingSubjectsExtra.ts', "import '../training/index.js';"],
  ['src/runtime/registry.ts', "import { SubjectAdapterRegistration } from '../training/subjects/index.js';"],
  ['src/runtime/registry.ts', "export * from '../training/subjects/index.js';"],
  ['src/runtime/registry.ts', "await import('../training/subjects/index.js');"],
  ['src/runtime/registry.ts', "import type { SubjectAdapterRegistration } from '../training/subjects/index.js'; await import('../training/subjects/index.js');"],
])('rejects a forbidden dependency from %s: %s', (filename, source) => {
  expect(boundaryViolations(path.join(root, filename), source)).not.toEqual([]);
});

test.each([
  ['src/runtime/daimon/training/check.ts', "import '../../../training/index.js';"],
  ['src/runtime/codex-exec/training/check.ts', "import '../../../training/index.js';"],
  ['src/runtime/trainingSubjects.ts', "import '../training/subjects/index.js';"],
  ['src/runtime/trainingCli.ts', "import '../training/cli/index.js';"],
  ['src/runtime/trainingSubjects.test.ts', "import '../training/cli/fixture.js';"],
  ['src/runtime/trainingCli.test.ts', "import '../training/cli/fixture.js';"],
  ['src/runtime/registry.ts', "import type { SubjectAdapterRegistration } from '../training/subjects/index.js';"],
])('allows a scoped training integration from %s: %s', (filename, source) => {
  expect(boundaryViolations(path.join(root, filename), source)).toEqual([]);
});

test('all training folders are checked and legitimate imports remain valid', () => {
  expect(boundaryViolations(path.join(root, 'src/training/subjects/runtime.ts'), "import '../../runtime/index.js';")).not.toEqual([]);
  expect(boundaryViolations(path.join(root, 'src/training/adapters-extra/runtime.ts'), "import '../../runtime/index.js';")).not.toEqual([]);
  expect(boundaryViolations(path.join(root, 'src/training/evaluation/check.ts'), "import '../contracts/index.js';")).toEqual([]);
  expect(boundaryViolations(path.join(root, 'src/cli/check.ts'), "import '../compiler/training/index.js';")).toEqual([]);
});


test.each([
  `const name = 'node:fs'; await import(name);`,
  `await import(process.env.MODULE);`,
  "await import(`node:fs`);",
  `const hidden = '${['@noopolis', 'daimon'].join('/')}';`,
])('rejects hidden runtime coupling: %s', source => {
  expect(boundaryViolations(path.join(trainingRoot, 'subjects/check.ts'), source)).not.toEqual([]);
});

test('training tests retain the runtime package literal boundary', () => {
  expect(boundaryViolations(path.join(trainingRoot, 'subjects/check.test.ts'),
    `const name = '${['@noopolis', 'daimon'].join('/')}';`)).toContain('runtime package literal');
});

test.each([
  "const tail = 'compiler/index.js'; await import('../../' + tail);",
  "export { thing } from 'node:fs'; const target = '../../compiler/index.js'; await import(target);",
  "define(['node:fs'], () => null); const target = '../../compiler/index.js'; await import(target);",
  "declare module 'ambient' {} const target = '../../compiler/index.js'; await import(target);",
  "const target = '../../compiler/index.js'; await import /* comment */ (target);",
  "const note = `outer ${`inner ${1}`}`; const target = '../../compiler/index.js'; await import(target);",
  "const note = `outer ${{ value: 1 }.value} tail`; const target = '../../compiler/index.js'; await import(target);",
  "const pattern = /`/; const target = '../../compiler/index.js'; await import(target);",
  "const target = '../../compiler/index.js'; require<unknown>(target);",
  "const target = '../../compiler/index.js'; require?.(target);",
  "const target = '../../compiler/index.js'; requ\\u0069re(target);",
  "const hidden = '\\u0040noopolis/daimon';",
])('retains full syntax checks for complex coupling: %s', source => {
  expect(boundaryViolations(path.join(trainingRoot, 'evaluation/check.ts'), source)).not.toEqual([]);
});

test('Daimon package text stays under its runtime owner throughout source files', async () => {
  // Literal test expectations are independent pins; training tests retain the core boundary.
  const files = (await sourceFiles(path.join(root, 'src'), false)).filter(filename =>
    !inside(path.join(root, 'src/runtime/daimon'), filename) && !(filename.endsWith('.test.ts') && !inside(trainingRoot, filename)));
  const forbidden = ['@noopolis', 'daimon'].join('/');
  const violations = await Promise.all(files.map(async filename => (await readFile(filename, 'utf8')).includes(forbidden) ? path.relative(root, filename) : undefined));
  expect(violations.filter(Boolean)).toEqual([]);
});
