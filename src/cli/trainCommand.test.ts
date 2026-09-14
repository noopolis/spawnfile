import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "./runCli.js";
import type { DelegatePaideiaTrainingOptions } from "./paideiaDelegation.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function project(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-train-command-")));
  directories.push(root);
  await writeFile(path.join(root, "Spawnfile"), 'spawnfile_version: "0.1"\nkind: agent\nname: author\nruntime: daimon\n');
  return root;
}
const base = ["--train", "train.paideia.yaml", "--test", "test.paideia.yaml", "--out", "local output"];

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

  it.each([1, 2, 130, 143])("propagates the delegated exit %s", async (exitCode) => {
    const code = await runCli(["train", await project(), ...base], { handlers: { delegatePaideiaTraining: async () => exitCode },
      streams: { stdout: () => undefined, stderr: () => undefined } });
    expect(code).toBe(exitCode);
  });

  it("forwards cancellation and default executable/timeout without forcing dry-run", async () => {
    const controller = new AbortController();
    let captured: DelegatePaideiaTrainingOptions | undefined;
    expect(await runCli(["train", await project(), ...base, "--optimizer-model", "fable", "--bridge-command", "bridge", "--max-proposals", "1", "--seed", "0", "--view", "0"], {
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
