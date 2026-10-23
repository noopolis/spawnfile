import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import * as ts from "typescript";

const root = fileURLToPath(new URL("../../", import.meta.url));
const forbidden = /@noopolis\/paideia|\/opt\/(?:training\/)?paideia\b|\bpaideia\s+train\b|\/(?:packages|bin)\/paideia\b/u;
const isTest = (file: string): boolean => /(?:^|\/)(?:__tests__|fixtures)(?:\/|$)|\.(?:test|test-helper)\.[^/]+$/u.test(file);

// Also reject forwarding an opaque executable through a supervisor with a separate
// train argv element: that delegation need not contain the executable's name.
const commandName = /(?:command|executable|binary)$/iu;
const namesCommand = (node: ts.Node): boolean => commandName.test(
  ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : node.getText());
const processCall = /(?:^|\.)(?:spawn|spawnSync|execFile|execFileSync|launch|execute)$/u;
const usesExternalTraining = (source: string): boolean => {
  if (!/\bpaideia\b|["'`]train["'`]/u.test(source)) return false;
  const visit = (node: ts.Node): boolean => {
    if (ts.isStringLiteralLike(node) && node.text === "paideia") {
      let value: ts.Node = node;
      while (ts.isAsExpression(value.parent) || ts.isSatisfiesExpression(value.parent) || ts.isParenthesizedExpression(value.parent)) value = value.parent;
      const parent = value.parent;
      if ((ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) &&
        (namesCommand(parent.name) || (ts.isBindingElement(parent) && parent.propertyName && namesCommand(parent.propertyName)))) return true;
      if (ts.isBinaryExpression(parent) && commandName.test(parent.left.getText())) return true;
      if (ts.isCallExpression(parent) && (
        (processCall.test(parent.expression.getText()) && parent.arguments[0] === value) ||
        (parent.expression.getText().endsWith(".option") && parent.arguments.some(arg =>
          ts.isStringLiteralLike(arg) && /--[^ ]*(?:command|executable|binary)/u.test(arg.text))))) return true;
    }
    if (ts.isCallExpression(node) && processCall.test(node.expression.getText()) &&
      node.arguments.some(arg => ts.isArrayLiteralExpression(arg) && arg.elements.some(
        element => ts.isStringLiteralLike(element) && element.text === "train"))) return true;
    return ts.forEachChild(node, visit) ?? false;
  };
  return visit(ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true));
};

const scan = (files: readonly string[], read: (file: string) => string): string[] => files
  .filter(file => file && !file.startsWith("src/training/") && !isTest(file))
  .filter(file => { const source = read(file); return forbidden.test(source) || usesExternalTraining(source); });

const git = (cwd: string, args: string[]): string => {
  const { TYPESAFE_API_KEY: _key, ...env } = process.env;
  return execFileSync("git", args, { cwd, env, encoding: "utf8" });
};
const workingFiles = (cwd: string): string[] => git(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);

it("keeps external training packages, install paths and binaries out of maintained files", () => {
  const files = workingFiles(root);
  const violations = scan(files.filter(file => existsSync(path.join(root, file))),
    file => readFileSync(path.join(root, file), "utf8"));
  expect(violations).toEqual([]);
});

it("scans tracked and untracked working files while excluding ignored files", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "training-ownership-"));
  try {
    git(directory, ["init", "--quiet"]);
    writeFileSync(path.join(directory, ".gitignore"), "ignored.ts\n");
    for (const file of ["tracked.ts", "untracked.ts", "ignored.ts"]) {
      writeFileSync(path.join(directory, file), 'const command = "paideia";');
    }
    git(directory, ["add", "tracked.ts"]);
    expect(scan(workingFiles(directory), file => readFileSync(path.join(directory, file), "utf8")))
      .toEqual(["untracked.ts", "tracked.ts"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it.each([
  "import '@noopolis/paideia/cli'", "/opt/training/paideia/dist/cli.js",
  "/opt/paideia/native", "exec paideia train --dry-run", "./packages/paideia", "/usr/bin/paideia",
  'spawn("paideia", ["train", "--dry-run"])', "execFile('paideia', ['--version'])",
  'program.option("--paideia-command <executable>", "Training command", "paideia")',
  'const command = `paideia`; spawn(command, ["train"]);',
  'const { command = "paideia" } = options; spawn(command, args);',
  'function run({ executable = "paideia" }) {}',
  'const cfg = { "command": "paideia" };',
  'const cfg = { "executable": "paideia" };',
  'const command = "paideia" as const;',
  'const command = "paideia" satisfies string;',
  'const command = ("paideia");',
  'const { command: cmd = "paideia" } = options;',
  'spawn(process.execPath, ["--experimental-strip-types", supervisor, options.command, "train", ...options.args])'
])("rejects a reintroduced external training dependency: %s", source => {
  expect(scan(["src/cli/reintroduced.ts"], () => source)).toEqual(["src/cli/reintroduced.ts"]);
});

it("allows legacy context paths and versioned wire IDs", () => {
  expect(forbidden.test('/run/paideia/context.json paideia.training-cost-plan.v1')).toBe(false);
  expect(scan(["src/legacy.ts"], () => 'join(root, "paideia"); "paideia" in image.build; const permission = \'default_permissions="paideia"\';')).toEqual([]);
});

it("scans documentation and image recipes while exempting the core and test fixtures", () => {
  expect(scan(["README.md", "runtime-images/training/Dockerfile", "src/training/legacy.ts", "src/cli/example.test.ts", "src/compiler/fixtures.test-helper.ts"],
    () => "@noopolis/paideia")).toEqual(["README.md", "runtime-images/training/Dockerfile"]);
});
