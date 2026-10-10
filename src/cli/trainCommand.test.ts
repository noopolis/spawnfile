import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, type CliHandlers } from "./runCli.js";
import type { DelegatePaideiaTrainingOptions } from "./paideiaDelegation.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function project(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-train-command-")));
  directories.push(root);
  await writeFile(path.join(root, "Spawnfile"), 'spawnfile_version: "0.1"\nkind: agent\nname: author\nruntime: daimon\n');
  return root;
}
const container = ["--training-image", `sha256:${"a".repeat(64)}`, "--training-config", "/training.json"];
const base = ["--train", "train.paideia.yaml", "--test", "test.paideia.yaml", "--out", "local output"];
const { version: packageVersion } = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
const emptyPlan = (root: string): Awaited<ReturnType<CliHandlers["createTrainingPlan"]>> => ({
  agent: { id: "agent:author", name: "author" }, graders: [], optimizer: null,
  producer: { package: "spawnfile", version: packageVersion },
  project: { manifest: path.join(root, "Spawnfile"), root },
  record: null, targets: [], version: "spawnfile.training-plan.v1"
});

describe("spawnfile train --plan", () => {
  it.each([false, true])("prints the real authoring plan without execution with dryRun=%s", async (dryRun) => {
    const flags = dryRun ? ["--dry-run"] : [];
    const root = await project(), stdout: string[] = [], stderr: string[] = [];
    const forbidden = vi.fn(async () => { throw Error("must not execute, extract a context or authenticate"); });
    const code = await runCli(["train", root, "--plan", ...flags, "--timeout-ms", "invalid"], {
      handlers: { createTrainingContext: forbidden, delegatePaideiaTraining: forbidden, compileProject: forbidden,
        buildProject: forbidden, runProject: forbidden, upProject: forbidden, publishProject: forbidden,
        importClaudeCodeAuth: forbidden, importCodexAuth: forbidden, importGrokAuth: forbidden,
        requireAuthProfile: forbidden, provisionCredentials: forbidden },
      streams: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) }
    });
    expect(code).toBe(0);
    expect(stdout).toEqual([JSON.stringify(emptyPlan(root), null, 2)]);
    expect(stderr).toEqual([]);
    expect(forbidden).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(["Spawnfile"]);
  });

  it("forwards only the input, exact agent id and package version to the plan handler", async () => {
    const plan = emptyPlan("/canonical");
    const createTrainingPlan = vi.fn(async () => plan);
    const forbidden = vi.fn(async () => { throw Error("must not start training"); });
    const stdout: string[] = [];
    expect(await runCli(["train", "./project with spaces", "--plan", "--agent", "agent:author",
      "--train", "unused.yaml", "--out", "unused-output", "--training-config", "unused.json", "--resume"], {
      handlers: { createTrainingPlan, createTrainingContext: forbidden, delegatePaideiaTraining: forbidden },
      streams: { stdout: (value) => stdout.push(value), stderr() {} }
    })).toBe(0);
    expect(createTrainingPlan).toHaveBeenCalledExactlyOnceWith("./project with spaces", { agent: "agent:author", packageVersion });
    expect(stdout).toEqual([JSON.stringify(plan, null, 2)]);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("writes exactly one trailing newline through the default stdout stream", async () => {
    const root = await project();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const forbidden = vi.fn(async () => { throw Error("must not start training"); });
    try {
      expect(await runCli(["train", root, "--plan"], {
        handlers: { createTrainingContext: forbidden, delegatePaideiaTraining: forbidden }
      })).toBe(0);
      expect(stdout).toHaveBeenCalledExactlyOnceWith(`${JSON.stringify(emptyPlan(root), null, 2)}\n`);
      expect(stderr).not.toHaveBeenCalled();
      expect(forbidden).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it.each([false, true])("requires --train before context extraction without --plan with dryRun=%s", async (dryRun) => {
    const flags = dryRun ? ["--dry-run"] : [];
    const forbidden = vi.fn(async () => { throw Error("must not read the project"); });
    const stderr: string[] = [];
    expect(await runCli(["train", "/missing", ...flags], {
      handlers: { createTrainingPlan: forbidden, createTrainingContext: forbidden, delegatePaideiaTraining: forbidden },
      streams: { stdout() {}, stderr: (value) => stderr.push(value) }
    })).toBe(2);
    expect(stderr).toEqual(["error: required option '--train <value>' not specified"]);
    expect(forbidden).not.toHaveBeenCalled();
  });
});

describe("spawnfile train", () => {
  it("resolves the real canonical project and forwards only explicit Paideia options", async () => {
    const root = await project(), stdout: string[] = [], stderr: string[] = [];
    const delegate = vi.fn(async (_options: DelegatePaideiaTrainingOptions) => 0);
    const forbidden = vi.fn(async () => { throw new Error("must not compile, build or authenticate"); });
    const code = await runCli(["train", root, ...base, "--agent", "agent:author", "--dry-run",
      "--paideia-command", "/opt/paideia with space", "--editable", "a.md", "--editable", "b.md", "--resource", "archive=/private/source",
      "--judge", "editor=fable", "--judge", "grounding=other-model", "--judge-citation-repairs", "editor=1",
      "--judge-citation-repairs", "grounding=0", "--validation-group", "previous", "--cost-config", "prices.yaml", "--max-trials", "3", "--timeout-ms", "5000"], {
      streams: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) },
      handlers: { delegatePaideiaTraining: delegate, compileProject: forbidden, buildProject: forbidden, importCodexAuth: forbidden }
    });
    expect(code).toBe(0); expect(forbidden).not.toHaveBeenCalled();
    expect(delegate).toHaveBeenCalledOnce();
    const options = delegate.mock.calls[0]![0];
    expect(options.context.agent.id).toBe("agent:author");
    expect(options.command).toBe("/opt/paideia with space");
    expect(options.dryRun).toBe(true); expect(options.timeoutMs).toBe(10_000);
    expect(options.args).toEqual(["--train", "train.paideia.yaml", "--test", "test.paideia.yaml", "--editable", "a.md", "--editable", "b.md",
      "--resource", "archive=/private/source", "--judge", "editor=fable", "--judge", "grounding=other-model",
      "--judge-citation-repairs", "editor=1", "--judge-citation-repairs", "grounding=0", "--validation-group", "previous",
      "--out", "local output", "--max-trials", "3", "--timeout-ms", "5000", "--cost-config", "prices.yaml", "--dry-run"]);
    expect(stderr).toEqual([]);
  });

  it("delegates YAML-owned test selection and permits the complete YAML time budget", async () => {
    const delegate = vi.fn(async (_options: DelegatePaideiaTrainingOptions) => 0);
    expect(await runCli(["train", await project(), "--train", "train.paideia.yaml", "--dry-run"], {
      handlers: { delegatePaideiaTraining: delegate }, streams: { stdout: () => undefined, stderr: () => undefined }
    })).toBe(0);
    expect(delegate.mock.calls[0]![0]).toMatchObject({ timeoutMs: 3_605_000, args: ["--train", "train.paideia.yaml", "--dry-run"] });
  });

  it("forwards explicit resume to Paideia without changing canonical agent context", async () => {
    const delegate = vi.fn(async (_options: DelegatePaideiaTrainingOptions) => 0);
    expect(await runCli(["train", await project(), ...base, ...container, "--resume"], {
      handlers: { delegatePaideiaTraining: delegate }, streams: { stdout: () => undefined, stderr: () => undefined }
    })).toBe(0);
    expect(delegate.mock.calls[0]![0].args).toEqual([...base, "--resume"]);
    expect(delegate.mock.calls[0]![0].context.agent.id).toBe("agent:author");
    expect(delegate.mock.calls[0]![0].dryRun).toBe(false);
  });

  it.each([1, 2, 130, 143])("propagates the delegated exit %s", async (exitCode) => {
    const code = await runCli(["train", await project(), ...base, ...container], { handlers: { delegatePaideiaTraining: async () => exitCode },
      streams: { stdout: () => undefined, stderr: () => undefined } });
    expect(code).toBe(exitCode);
  });

  it("forwards cancellation and default executable/timeout without forcing dry-run", async () => {
    const controller = new AbortController();
    let captured: DelegatePaideiaTrainingOptions | undefined;
    expect(await runCli(["train", await project(), ...base, ...container, "--optimizer-model", "fable", "--bridge-command", "bridge", "--max-proposals", "1", "--seed", "0", "--view", "0"], {
      signal: controller.signal, handlers: { delegatePaideiaTraining: async (options) => { captured = options; return 2; } },
      streams: { stdout: () => undefined, stderr: () => undefined }
    })).toBe(2);
    expect(captured).toMatchObject({ command: "paideia", timeoutMs: 3_605_000, signal: controller.signal, dryRun: false });
    expect(captured?.args).toContain("--bridge-command");
    expect(captured?.args).not.toContain("--dry-run");
  });

  it("allows dry-run without output or optimizer bridge, but rejects an actual run without output", async () => {
    const root = await project(), delegated = vi.fn(async () => 0);
    const args = ["train", root, "--train", "train.paideia.yaml", "--test", "test.paideia.yaml"];
    const options = { handlers: { delegatePaideiaTraining: delegated }, streams: { stdout: () => undefined, stderr: () => undefined } };
    expect(await runCli([...args, "--dry-run"], options)).toBe(0);
    expect(delegated).toHaveBeenCalledOnce();
    expect(await runCli(args, options)).toBe(2);
    expect(delegated).toHaveBeenCalledOnce();
  });

  it.each(["0", "1.5", "-1", "NaN", "3600001"])("rejects timeout %s before extracting or delegating", async (timeout) => {
    const forbidden = vi.fn(async () => { throw Error("must not start"); });
    const code = await runCli(["train", "/missing", ...base, "--timeout-ms", timeout], {
      handlers: { createTrainingContext: forbidden, delegatePaideiaTraining: forbidden }, streams: { stdout: () => undefined, stderr: () => undefined }
    });
    expect(code).toBe(2); expect(forbidden).not.toHaveBeenCalled();
  });

  it("rejects generic runtime/instruction overrides and missing required datasets", async () => {
    const forbidden = vi.fn(async () => { throw Error("must not start"); });
    for (const args of [["train", ...base, "--runtime", "pi"], ["train", ...base, "--instructions", "prompt.md"], ["train", "--dry-run"]]) {
      expect(await runCli(args, { handlers: { delegatePaideiaTraining: forbidden }, streams: { stdout: () => undefined, stderr: () => undefined } })).toBe(2);
    }
    expect(forbidden).not.toHaveBeenCalled();
  });
  it("forwards literal invalid repair selections for Paideia to validate and preserves receiver failure", async () => {
    const root = await project();
    const delegate = vi.fn(async (_options: DelegatePaideiaTrainingOptions) => 2);
    const literal = "unknown=$(false) with spaces";
    expect(await runCli(["train", root, ...base, "--judge-citation-repairs", literal,
      "--judge-citation-repairs", literal, "--dry-run"], {
      handlers: { delegatePaideiaTraining: delegate }, streams: { stdout: () => undefined, stderr: () => undefined }
    })).toBe(2);
    expect(delegate.mock.calls[0]![0].args).toEqual(["--train", "train.paideia.yaml", "--test", "test.paideia.yaml",
      "--judge-citation-repairs", literal, "--judge-citation-repairs", literal, "--out", "local output", "--dry-run"]);
  });
});

it("keeps public repair authority separate from forwarded optimizer flags", async () => {
  const delegate = vi.fn(async (_options: DelegatePaideiaTrainingOptions) => 0);
  expect(await runCli(["train", await project(), ...base, "--training-config", "/recipe.json", "--repair-measurements", "/parent", "--repair-witness", "/witness.json"], {
    handlers: { delegatePaideiaTraining: delegate }, streams: { stdout() {}, stderr() {} }
  })).toBe(0);
  expect(delegate.mock.calls[0]![0]).toMatchObject({ repairMeasurements: "/parent", repairWitness: "/witness.json" });
  expect(delegate.mock.calls[0]![0].args).not.toContain("--repair-measurements");
  expect(delegate.mock.calls[0]![0].args).not.toContain("--repair-context");
});
