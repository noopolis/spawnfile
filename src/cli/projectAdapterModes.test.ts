import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { type AdapterSandbox, adapterModuleSource, agentManifest, createAdapterSandbox } from "../projectAdapters/adapterSandbox.test-helper.js";
import { readDeclaredProjectAdapters } from "../projectAdapters/declarations.js";
import { loadProjectRuntimeAdapterPlugins } from "../projectAdapters/loadProjectAdapters.js";
import { createCliProgram } from "./cliProgram.js";
import { projectAdapterOperand } from "./projectAdapterCommands.js";
import { runCli } from "./runCli.js";

let sandbox: AdapterSandbox;
beforeEach(async () => {
  sandbox = await createAdapterSandbox();
  vi.stubEnv("SPAWNFILE_HOME", sandbox.home);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(sandbox.root, { force: true, recursive: true });
});

const cli = async (argv: string[], handlers = {}) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    adapterCwd: sandbox.root, handlers,
    streams: { stderr: (line) => stderr.push(line), stdout: (line) => stdout.push(line) }
  });
  return { code, stderr: stderr.join("\n"), stdout: stdout.join("\n") };
};

/** Parses argv against the real program with every action stubbed, returning the operand the hook would use. */
const operandFor = async (argv: string[]): Promise<string | undefined> => {
  const { program } = createCliProgram({
    handlers: {}, renderEnvironment: { ci: true, noColor: true, stdoutIsTty: false },
    stdin: (async function* () {})(), streams: { stderr: () => undefined, stdout: () => undefined }
  }, false);
  let seen: { operand: string | undefined } | undefined;
  const stub = (command: Command) => {
    command.action(function (this: Command) { seen = { operand: projectAdapterOperand(this) }; });
    command.commands.forEach(stub);
  };
  program.commands.forEach(stub);
  await program.parseAsync(argv, { from: "user" });
  if (!seen) throw new Error(`no action ran for ${argv.join(" ")}`);
  return seen.operand;
};

it("follows each handler's parsed mode, defaulting a missing path to cwd", async () => {
  const project = path.join(sandbox.root, "empty");
  await mkdir(project);
  vi.spyOn(process, "cwd").mockReturnValue(project);

  for (const argv of [["view"], ["status"], ["compile"], ["up"], ["run"], ["train"], ["status", "--deployment", "d", "--context", "c"]]) {
    expect(await operandFor(argv), argv.join(" ")).toBe(project);
  }
  for (const argv of [["artifacts", "export", project, "--out", "o"], ["down", project, "--deployment", "d"], ["compile", project]]) {
    expect(await operandFor(argv), argv.join(" ")).toBe(project);
  }
  expect(await operandFor(["status", ".", "--deployment", "d"])).toBe(".");
  for (const argv of [
    ["up", "--image", "."], ["run", "--image", "."], ["status", "--image", "."], ["up", "example/org:1"],
    ["run", "example/org:1"], ["status", "example/org:1"], ["status", "--deployment", "d"],
    ["train", "--regrade", "m.json", "--out", "o"], ["runtimes"]
  ]) {
    expect(await operandFor(argv), argv.join(" ")).toBeUndefined();
  }
});

const twoHarnessTeam = async (): Promise<string> => {
  const team = await sandbox.project("team", [
    'spawnfile_version: "0.1"', "kind: team", "name: pair", "adapters:", "  left-harness: ./adapters/left.mjs",
    "  right-harness: ./adapters/right.mjs", "mode: swarm", "members:", "  - id: left", "    ref: ./left",
    "  - id: right", "    ref: ./right", ""
  ].join("\n"), { "adapters/left.mjs": "left-harness", "adapters/right.mjs": "right-harness" });
  await sandbox.project("team/left", agentManifest("left", "left-harness"));
  await sandbox.project("team/right", agentManifest("right", "right-harness"));
  return team;
};

it("loads the current directory's adapters for view and skips them in image mode", async () => {
  const team = await twoHarnessTeam();
  vi.spyOn(process, "cwd").mockReturnValue(team);

  const imageRun = await cli(["run", "--image", "."]);
  expect(imageRun).toMatchObject({ code: 2, stderr: expect.stringContaining("Image-mode run is not supported") });
  expect(await sandbox.evaluated()).toEqual([]);

  const viewed = await cli(["view"]);
  expect(viewed).toMatchObject({ code: 0, stderr: "" });
  expect(await sandbox.evaluated()).toEqual(["left-harness", "right-harness"]);
});

it("loads a confined module under a directory whose name starts with two dots", async () => {
  const project = await sandbox.project("p", agentManifest("a", "dotted", { dotted: "./..plugins/m.mjs" }), {
    "..plugins/m.mjs": "dotted"
  });
  const plugins = await loadProjectRuntimeAdapterPlugins(project);
  expect(plugins.map(({ adapter }) => adapter.name)).toEqual(["dotted"]);
});

it("requires an adapters document to be a valid Spawnfile, and leaves documents without the key alone", async () => {
  const foreign = path.join(sandbox.root, "report");
  await mkdir(foreign);
  await writeFile(path.join(foreign, "Spawnfile"), "kind: report\nadapters:\n  x: ./x.mjs\n");
  await writeFile(path.join(foreign, "x.mjs"), adapterModuleSource("x", sandbox.marker));
  await expect(readDeclaredProjectAdapters(foreign)).rejects.toThrow(/Invalid Spawnfile manifest/u);
  expect(await cli(["validate", foreign])).toMatchObject({ code: 2, stderr: expect.stringContaining("Invalid Spawnfile manifest") });
  expect(await sandbox.evaluated()).toEqual([]);

  await writeFile(path.join(foreign, "Spawnfile"), "kind: report\nother: true\n");
  await expect(readDeclaredProjectAdapters(foreign)).resolves.toBeUndefined();
});
