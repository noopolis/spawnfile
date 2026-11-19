import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { type AdapterSandbox, agentManifest, createAdapterSandbox } from "../projectAdapters/adapterSandbox.test-helper.js";
import { renderSpawnfile } from "../manifest/index.js";
import { addRuntimeAdapterPlugins, listRuntimeAdapters, withRuntimeAdapterPlugins } from "../runtime/registry.js";
import { createCliProgram } from "./cliProgram.js";
import { PROJECT_ADAPTER_COMMANDS, commandPath } from "./projectAdapterCommands.js";
import { runCli } from "./runCli.js";

let sandbox: AdapterSandbox;
beforeEach(async () => {
  sandbox = await createAdapterSandbox();
  vi.stubEnv("SPAWNFILE_HOME", sandbox.home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(sandbox.root, { force: true, recursive: true });
});

const cli = async (argv: string[], handlers = {}) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    adapterCwd: sandbox.root,
    handlers,
    streams: { stderr: (line) => stderr.push(line), stdout: (line) => stdout.push(line) }
  });
  return { code, stderr: stderr.join("\n"), stdout: stdout.join("\n") };
};

const teamManifest = (adapters?: Record<string, string>) => [
  'spawnfile_version: "0.1"', "kind: team", "name: pair",
  ...(adapters ? ["adapters:", ...Object.entries(adapters).map(([id, spec]) => `  ${id}: ${spec}`)] : []),
  "mode: swarm", "members:", "  - id: left", "    ref: ./left", "  - id: right", "    ref: ./right", ""
].join("\n");

const twoHarnessTeam = async () => {
  const team = await sandbox.project("team", teamManifest({ "right-harness": "./adapters/right.mjs", "left-harness": "./adapters/left.mjs" }), {
    "adapters/left.mjs": "left-harness", "adapters/right.mjs": "right-harness"
  });
  await sandbox.project("team/left", agentManifest("left", "left-harness"));
  await sandbox.project("team/right", agentManifest("right", "right-harness"));
  return team;
};

it("refuses an unapproved team before import, then validates the whole two-harness graph from any cwd once trusted", async () => {
  const team = await twoHarnessTeam();
  const refused = await cli(["validate", team]);
  expect(refused).toMatchObject({ code: 2, stderr: expect.stringMatching(/not approved.*adapters trust/su) });
  expect(await sandbox.evaluated()).toEqual([]);

  const trusted = await cli(["adapters", "trust", team]);
  expect(trusted.code).toBe(0);
  expect(trusted.stdout).toContain("adapter left-harness ./adapters/left.mjs\nadapter right-harness ./adapters/right.mjs");
  expect(await sandbox.evaluated()).toEqual([]);

  const cwd = vi.spyOn(process, "cwd").mockReturnValue(path.join(team, "left"));
  try {
    const validated = await cli(["validate", team]);
    expect(validated).toMatchObject({ code: 0, stdout: expect.stringContaining("runtimes: left-harness, right-harness") });
  } finally {
    cwd.mockRestore();
  }
  expect(listRuntimeAdapters()).not.toContain("left-harness");

  await writeFile(path.join(team, "Spawnfile"), teamManifest({ "left-harness": "./adapters/right.mjs", "right-harness": "./adapters/left.mjs" }));
  expect(await cli(["validate", team])).toMatchObject({ code: 2, stderr: expect.stringContaining("changed since approval") });
  expect(await sandbox.evaluated()).toEqual(["left-harness", "right-harness"]);
});

it("gates compile and report-backed teardown on the operand's trusted declarations", async () => {
  const team = await twoHarnessTeam();
  const out = path.join(sandbox.root, "out");
  const downDeployment = vi.fn(async () => { throw new Error("teardown reached"); });
  expect((await cli(["down", team, "--deployment", "d"], { downDeployment })).stderr).toContain("not approved");
  expect((await cli(["artifacts", "export", team, "--out", out])).stderr).toContain("not approved");
  expect(downDeployment).not.toHaveBeenCalled();
  expect(await sandbox.evaluated()).toEqual([]);
  await cli(["adapters", "trust", path.join(team, "Spawnfile")]);
  const compiled = await cli(["compile", team, "--out", out]);
  // The fixture catalog has no install pin, so reaching this adapter-owned refusal proves registration.
  expect(compiled.stderr).toContain("Runtime left-harness must use a compiled artifact install");
  expect(await sandbox.evaluated()).toEqual(["left-harness", "right-harness"]);
});

it("rejects a nested member declaration with an actionable error instead of honoring it", async () => {
  const team = await twoHarnessTeam();
  await writeFile(path.join(team, "left", "Spawnfile"), agentManifest("left", "left-harness", { "left-harness": "./x.mjs" }));
  await cli(["adapters", "trust", team]);
  expect(await cli(["validate", team])).toMatchObject({
    code: 2, stderr: expect.stringMatching(/left\/Spawnfile: adapters may only be declared in the root Spawnfile/u)
  });
  await writeFile(path.join(team, "Spawnfile"), teamManifest().replace("  - id: left\n    ref: ./left", [
    "  - id: left", "    runtime: left-harness", "    adapters:", "      left-harness: ./x.mjs",
    "    workspace:", "      docs:", "        system: AGENTS.md"
  ].join("\n")));
  expect(await cli(["validate", team])).toMatchObject({ code: 2, stderr: expect.stringContaining("adapters may only be declared in the root") });
});

it("keeps explicit --adapter authoritative, and never loads declarations for nonproject, help, image or trust-only paths", async () => {
  const project = await sandbox.project("p", agentManifest("a", "echo-one", { "echo-one": "./declared.mjs" }), {
    "declared.mjs": "echo-one", "explicit.mjs": "echo-one"
  });
  const explicit = await cli(["--adapter", path.join(project, "explicit.mjs"), "validate", project]);
  expect(explicit).toMatchObject({ code: 0, stdout: expect.stringContaining("runtimes: echo-one") });
  expect(await sandbox.evaluated()).toEqual(["echo-one"]);
  await rm(sandbox.marker);

  const cwd = vi.spyOn(process, "cwd").mockReturnValue(project);
  try {
    for (const argv of [["runtimes"], ["validate", "--help"], ["compile", "--help"], ["up", "--image", "example/org:1", "--help"]]) {
      expect((await cli(argv)).code, argv.join(" ")).toBe(0);
    }
    expect((await cli(["up", "--image", "example/org:1"], { consumeImageUp: async () => { throw new Error("image path"); } })).stderr)
      .toContain("image path");
  } finally {
    cwd.mockRestore();
  }
  expect(await sandbox.evaluated()).toEqual([]);
});

it("preserves declarations on normal manifest rewrites", async () => {
  const project = await sandbox.project("p", agentManifest("a", "echo-one", { "echo-one": "./e.mjs", alpha: "./a.mjs" }), {
    "a.mjs": "alpha", "e.mjs": "echo-one"
  });
  await cli(["adapters", "trust", project]);
  expect(await cli(["model", "set", "anthropic", "claude-sonnet-4-5", project])).toMatchObject({ code: 0, stderr: "" });
  const rewritten = await readFile(path.join(project, "Spawnfile"), "utf8");
  expect(rewritten).toMatch(/adapters:\n {2}alpha: \.\/a\.mjs\n {2}echo-one: \.\/e\.mjs\n/u);
  expect(renderSpawnfile({ adapters: { b: "./b.mjs", a: "./a.mjs" }, kind: "agent", name: "x", spawnfile_version: "0.1" }))
    .toMatch(/adapters:\n {2}a: \.\/a\.mjs\n {2}b: \.\/b\.mjs/u);
});

it("isolates concurrent invocation scopes", async () => {
  const one = await sandbox.project("one", agentManifest("a", "only-one", { "only-one": "./m.mjs" }), { "m.mjs": "only-one" });
  const two = await sandbox.project("two", agentManifest("b", "only-two", { "only-two": "./m.mjs" }), { "m.mjs": "only-two" });
  await cli(["adapters", "trust", one]);
  await cli(["adapters", "trust", two]);
  const [first, second] = await Promise.all([cli(["validate", one]), cli(["validate", two])]);
  expect(first.stdout).toContain("runtimes: only-one");
  expect(second.stdout).toContain("runtimes: only-two");
  await expect(addRuntimeAdapterPlugins([])).rejects.toThrow(/inside withRuntimeAdapterPlugins/u);
  await withRuntimeAdapterPlugins([], () => expect(listRuntimeAdapters()).not.toContain("only-one"));
});

it("classifies every project-path command and nothing else", () => {
  const { program } = createCliProgram({
    handlers: {}, renderEnvironment: { ci: true, noColor: true, stdoutIsTty: false },
    stdin: (async function* () {})(), streams: { stderr: () => undefined, stdout: () => undefined }
  }, false);
  const projectCommands: string[] = [];
  const visit = (command: Command) => {
    const argument = command.registeredArguments.find((candidate) => candidate.name() === "path");
    if (argument && /Spawnfile path/u.test(argument.description)) projectCommands.push(commandPath(command));
    command.commands.forEach(visit);
  };
  visit(program);
  expect(projectCommands.filter((name) => name !== "adapters trust").sort()).toEqual([...PROJECT_ADAPTER_COMMANDS].sort());
});
