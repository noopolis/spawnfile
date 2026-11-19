import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import type { RuntimeMoltnetWorkspace } from "../runtime/index.js";
import { createMoltnetWorkspace } from "../runtime/portableMoltnetWiring.js";
import { writeEmittedFiles } from "./compileProjectSupport.js";
import { assertMoltnetSkillLayout, installMoltnetSkillFiles } from "./moltnetSkillInstall.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
const newRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-skill-install-"));
  roots.push(root);
  return root;
};

const SKILL = "# name: moltnet\nfixture skill\n";

/** Benign stand-in installer whose behavior is selected by `--runtime`. */
const createInstaller = async (): Promise<{ cli: string; log: string }> => {
  const directory = await newRoot();
  const cli = path.join(directory, "moltnet.cjs");
  const log = path.join(directory, "workspaces.log");
  await writeFile(cli, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const args = process.argv.slice(2);",
    "const runtime = args[args.indexOf('--runtime') + 1];",
    "const workspace = args[args.indexOf('--workspace') + 1];",
    `fs.appendFileSync(${JSON.stringify(log)}, workspace + '\\n');`,
    "const configPath = runtime === 'separate' ? path.join(path.dirname(workspace), 'state/config.json') : path.join(workspace, '.moltnet/config.json');",
    "const config = fs.readFileSync(configPath, 'utf8');",
    "const put = (relative, content) => {",
    "  fs.mkdirSync(path.dirname(path.join(workspace, relative)), { recursive: true });",
    "  fs.writeFileSync(path.join(workspace, relative), content);",
    "};",
    `const skill = ${JSON.stringify(SKILL)} + config;`,
    "if (runtime === 'fail') { process.stderr.write('installer refused\\n'); process.exit(3); }",
    "if (runtime === 'multi') { put('.agents/skills/moltnet/SKILL.md', skill); put('.codex/skills/moltnet/SKILL.md', skill); }",
    "if (['plain', 'extra', 'separate'].includes(runtime)) put('skills/moltnet/SKILL.md', skill);",
    "if (runtime === 'merge') put('GEMINI.md', fs.readFileSync(path.join(workspace, 'GEMINI.md'), 'utf8') + skill);",
    "if (runtime === 'extra') put('skills/other/NOTES.md', 'unexpected\\n');",
    "if (runtime === 'link') {",
    "  put('elsewhere.md', 'linked\\n');",
    "  fs.mkdirSync(path.join(workspace, 'skills', 'moltnet'), { recursive: true });",
    "  fs.symlinkSync(path.join(workspace, 'elsewhere.md'), path.join(workspace, 'skills', 'moltnet', 'SKILL.md'));",
    "}",
    "if (runtime === 'dirlink') {",
    "  put('real/moltnet/SKILL.md', skill);",
    "  fs.symlinkSync(path.join(workspace, 'real'), path.join(workspace, 'skills'));",
    "}"
  ].join("\n") + "\n");
  await chmod(cli, 0o755);
  return { cli, log };
};

const config = { content: "{\"fixture\":true}\n", path: "workspace/.moltnet/config.json" };
const install = (cli: string, layout: RuntimeMoltnetWorkspace) =>
  installMoltnetSkillFiles({ agentName: "fixture", cliCommand: cli, emittedFiles: [config], layout });

it("returns only expected skill files from a private stage and removes the stage", async () => {
  const { cli, log } = await createInstaller();
  const files = await install(cli, createMoltnetWorkspace("extra", ["workspace/skills"]));
  expect(files).toEqual([{ content: `${SKILL}${config.content}`, path: "workspace/skills/moltnet/SKILL.md" }]);
  const stage = (await readFile(log, "utf8")).trim();
  expect(path.basename(stage)).toBe("workspace");
  await expect(readdir(path.dirname(stage))).rejects.toThrow(/ENOENT/u);
});

it("preserves native layouts with several skill destinations", async () => {
  const { cli } = await createInstaller();
  const files = await install(cli, createMoltnetWorkspace("multi", ["workspace/.agents/skills", "workspace/.codex/skills"]));
  expect(files.map((file) => file.path)).toEqual([
    "workspace/.agents/skills/moltnet/SKILL.md",
    "workspace/.codex/skills/moltnet/SKILL.md"
  ]);
});

it("lets the native installer extend an author's declared instruction file", async () => {
  const { cli } = await createInstaller();
  const instruction = { path: "workspace/GEMINI.md", content: "# Existing instructions\n" };
  const layout = { ...createMoltnetWorkspace("merge", []), skillPaths: [instruction.path] };
  const files = await installMoltnetSkillFiles({ agentName: "fixture", cliCommand: cli, emittedFiles: [instruction, config], layout });
  expect(files).toEqual([{ ...instruction, content: instruction.content + SKILL + config.content }]);
});

it("supports a client config next to the workspace inside the runtime output", async () => {
  const { cli } = await createInstaller();
  const layout = { ...createMoltnetWorkspace("separate", ["workspace/skills"]), clientConfigPath: "state/config.json" };
  const files = await installMoltnetSkillFiles({
    agentName: "fixture", cliCommand: cli, emittedFiles: [{ ...config, path: layout.clientConfigPath }], layout
  });
  expect(files).toEqual([{ path: layout.skillPaths[0], content: SKILL + config.content }]);
});

it.each([
  [{ workspaceRootPath: "../outside" }, /canonical relative file path/u],
  [{ skillPaths: ["/absolute/SKILL.md"] }, /canonical relative file path/u],
  [{ skillPaths: ["workspace/../SKILL.md"] }, /canonical relative file path/u],
  [{ skillPaths: ["config/SKILL.md"] }, /outside workspace/u],
  [{ clientConfigPath: "/state/config.json" }, /canonical relative file path/u]
])("refuses adapter layout %j before running the installer", async (override, message) => {
  const { cli, log } = await createInstaller();
  const layout = { ...createMoltnetWorkspace("plain", ["workspace/skills"]), ...override };
  expect(() => assertMoltnetSkillLayout(layout, "fixture")).toThrow(message);
  await expect(install(cli, layout)).rejects.toThrow(message);
  await expect(readFile(log, "utf8")).rejects.toThrow(/ENOENT/u);
});

it.each([
  ["plain", ["workspace/.agents/skills"], /was not produced/u],
  ["link", ["workspace/skills"], /regular file with one link/u],
  ["dirlink", ["workspace/skills"], /real directories/u],
  ["fail", ["workspace/skills"], /Unable to install the Moltnet skill into fixture: .*installer refused/su]
])("refuses %s installer output", async (runtime, skillRoots, message) => {
  const { cli } = await createInstaller();
  await expect(install(cli, createMoltnetWorkspace(runtime, skillRoots))).rejects.toThrow(message);
});

it("refuses to write staged skills through an existing link in a reused output", async () => {
  const { cli } = await createInstaller();
  const output = await newRoot();
  const agent = "runtimes/openclaw/agents/fixture";
  const skillDirectory = path.join(output, agent, "workspace/skills/moltnet");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(path.join(output, "kept.md"), "kept\n");
  await symlink(path.join(output, "kept.md"), path.join(skillDirectory, "SKILL.md"));
  const files = await install(cli, createMoltnetWorkspace("plain", ["workspace/skills"]));
  await expect(writeEmittedFiles(output, files, agent)).rejects.toThrow(/regular file with one link/u);
  expect(await readFile(path.join(output, "kept.md"), "utf8")).toBe("kept\n");
});
