import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli, type CliHandlers } from "./runCli.js";
import type { DelegatePaideiaTrainingOptions } from "./paideiaDelegation.js";
import {
  agentManifest, cleanTrainingProjects, dataFiles, example, trainingProject, volume
} from "../compiler/training/plan/fixtures.test-helper.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
afterEach(cleanTrainingProjects);
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

describe("spawnfile train --materialize", () => {
  it.each([example.id, `train:${example.id}`])("materializes %s locally without delegated training flags", async (selector) => {
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest() });
    const out = path.join(root, "rewound"), stdout: string[] = [], stderr: string[] = [];
    const forbidden = vi.fn(async () => { throw Error("must not execute, authenticate, or compile output"); });
    const code = await runCli(["train", path.join(root, "Spawnfile"), "--agent", "agent:writer",
      "--materialize", selector, "--out", out], {
      handlers: { createTrainingContext: forbidden, delegatePaideiaTraining: forbidden, compileProject: forbidden,
        buildProject: forbidden, runProject: forbidden, upProject: forbidden, publishProject: forbidden,
        importClaudeCodeAuth: forbidden, importCodexAuth: forbidden, importGrokAuth: forbidden,
        requireAuthProfile: forbidden, provisionCredentials: forbidden },
      streams: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) }
    });
    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    const moment = JSON.parse(stdout[0]!);
    expect(moment).toMatchObject({ status: "materialized", agent: "agent:writer",
      example: { id: example.id, role: "train", dataset: "training/train.yaml" }, inputs: [],
      record: { matched: false }, leakCheck: { ok: true, findings: 0 } });
    expect(JSON.parse(await readFile(path.join(out, "moment.json"), "utf8"))).toEqual(moment);
    expect(JSON.parse(await readFile(path.join(out, "task-clock.json"), "utf8"))).toEqual({
      version: "spawnfile.task-clock.v1", origin: "2026-10-09T08:20:31Z"
    });
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("lists ambiguous roles and materializes a qualified selection", async () => {
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest(),
      "training/test.yaml": { examples: [example] } });
    const out = path.join(root, "rewound"), stderr: string[] = [];
    const options = { streams: { stdout() {}, stderr: (value: string) => stderr.push(value) } };
    const args = ["train", root, "--agent", "agent:writer", "--out", out, "--materialize"];
    expect(await runCli([...args, example.id], options)).toBe(1);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toContain(`train:${example.id} (training/train.yaml)`);
    expect(stderr[0]).toContain(`test:${example.id} (training/test.yaml)`);
    expect(await readdir(root)).not.toContain("rewound");
    expect(await runCli([...args, `test:${example.id}`], options)).toBe(0);
    expect(JSON.parse(await readFile(path.join(out, "moment.json"), "utf8")).example.role).toBe("test");
  });

  it("retains the plan's single-agent inference when --agent is omitted", async () => {
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest() });
    const stdout: string[] = [];
    expect(await runCli(["train", root, "--materialize", example.id, "--out", path.join(root, "out")], {
      streams: { stdout: (value) => stdout.push(value), stderr() {} }
    })).toBe(0);
    expect(JSON.parse(stdout[0]!).agent).toBe("agent:writer");
  });

  it("forwards a loaded project, resolved plan, history and the existing --out option", async () => {
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest() });
    const materializeTrainingMoment = vi.fn<CliHandlers["materializeTrainingMoment"]>(async ({ plan }) => ({
      version: "spawnfile.materialized-moment.v1", status: "materialized", agent: plan.agent.id,
      example: { id: example.id, role: "train", dataset: "training/train.yaml" }, at: example.at, effectiveAt: example.at,
      inputs: [], record: { matched: false }, leakCheck: { ok: true, findings: 0 }
    }));
    const stdout: string[] = [];
    expect(await runCli(["train", root, "--agent", "agent:writer", "--materialize", example.id,
      "--history", "history with spaces", "--out", "out with spaces"], {
      handlers: { materializeTrainingMoment }, streams: { stdout: (value) => stdout.push(value), stderr() {} }
    })).toBe(0);
    expect(materializeTrainingMoment).toHaveBeenCalledOnce();
    expect(materializeTrainingMoment.mock.calls[0]![0]).toMatchObject({
      project: { root, manifest: path.join(root, "Spawnfile") },
      plan: { agent: { id: "agent:writer" }, producer: { version: packageVersion } },
      example: example.id, historyDir: "history with spaces", out: "out with spaces"
    });
    expect(JSON.parse(stdout[0]!).status).toBe("materialized");
  });

  it("returns one-line stderr and exit 1 for a refused moment with report-only output", async () => {
    const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest({
      workspace: { docs: { system: "AGENTS.md" }, resources: [volume] }
    }) });
    const out = path.join(root, "refused"), stdout: string[] = [], stderr: string[] = [];
    expect(await runCli(["train", root, "--agent", "agent:writer", "--materialize", example.id, "--out", out], {
      streams: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) }
    })).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/^error: Moment refused: 1 input refusal\(s\), 0 leak finding\(s\)/u);
    expect(stderr[0]).not.toContain("\n");
    expect(await readdir(out)).toEqual(["moment.json"]);
    expect(JSON.parse(await readFile(path.join(out, "moment.json"), "utf8"))).toMatchObject({
      status: "refused", inputs: [{ id: volume.id, refusal: expect.any(String) }]
    });
    expect((await readdir(root)).filter((name) => name.includes("staging"))).toEqual([]);
  });

  it.each([
    ["--materialize", example.id, "--agent", "agent:writer"],
    ["--materialize", example.id, "--agent", "agent:writer", "--out", "output", "--plan"],
    ["--history", "history", "--plan"]
  ])("rejects incomplete or conflicting local mode options %j before reads", async (...flags) => {
    const forbidden = vi.fn(async () => { throw Error("must not read project"); });
    expect(await runCli(["train", "/missing", ...flags], {
      handlers: { loadTrainingProject: forbidden, createTrainingPlan: forbidden, materializeTrainingMoment: forbidden,
        createTrainingContext: forbidden, delegatePaideiaTraining: forbidden }, streams: { stdout() {}, stderr() {} }
    })).toBe(2);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it("registers --out exactly once alongside --materialize and --history", async () => {
    const stdout: string[] = [];
    expect(await runCli(["train", "--help"], { streams: { stdout: (value) => stdout.push(value), stderr() {} } })).toBe(0);
    const help = stdout.join("\n");
    expect(help.match(/--out <value>/gu)).toHaveLength(1);
    expect(help).toContain("--materialize <example>");
    expect(help).toContain("--history <directory>");
  });
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
