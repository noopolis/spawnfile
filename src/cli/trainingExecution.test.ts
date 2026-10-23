import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { main } from "../runtime/trainingCli.js";
import { runTraining, type RunTrainingOptions } from "./trainingExecution.js";

const core = vi.hoisted(() => vi.fn<typeof main>());
vi.mock("../runtime/trainingCli.js", () => ({ main: core }));
const roots: string[] = [];
afterEach(async () => { core.mockReset(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = (): RunTrainingOptions => ({
  context: {} as RunTrainingOptions["context"], args: ["--dry-run"], dryRun: true,
  timeoutMs: 5000, streams: { stdout() {}, stderr() {} }
});

it("calls the runtime composition in-process with literal args, direct context and unchanged output lines", async () => {
  const stdout = vi.fn(), stderr = vi.fn();
  const args = ["--train", "$(false) with spaces", "--dry-run"];
  core.mockImplementation(async (argv, io, dependencies) => {
    expect(argv).toEqual(["train", ...args]);
    expect(dependencies?.spawnfileContext).toBe(input.context);
    expect(io.cwd).toBe(process.cwd());
    io.stdout('{"modelCallsMade":0}\n'); io.stderr("diagnostic\n");
    return 2;
  });
  const input = { ...options(), args, streams: { stdout, stderr } };
  expect(await runTraining(input)).toBe(2);
  expect(stdout).toHaveBeenCalledExactlyOnceWith('{"modelCallsMade":0}');
  expect(stderr).toHaveBeenCalledExactlyOnceWith("diagnostic");
});

it.each([["SIGINT", 130], ["SIGTERM", 143]] as const)("preserves %s cancellation and cleans up handlers", async (signal, code) => {
  const once = vi.spyOn(process, "once");
  let listener: (() => void) | undefined;
  core.mockImplementation(async (_argv, io) => {
    listener = once.mock.calls.find(([name]) => name === signal)![1] as () => void;
    listener(); expect(io.signal?.aborted).toBe(true);
    return 130;
  });
  expect(await runTraining(options())).toBe(code);
  expect(process.listeners(signal)).not.toContain(listener);
});

it("passes external cancellation without starting an already-cancelled invocation", async () => {
  const controller = new AbortController(); controller.abort();
  expect(await runTraining({ ...options(), signal: controller.signal })).toBe(130);
  expect(core).not.toHaveBeenCalled();
});

it("rejects exit zero without a final cost-plan receipt", async () => {
  core.mockResolvedValue(0);
  await expect(runTraining(options())).rejects.toThrow("required final training receipt");
});

it("rejects a dry-run receipt that reports model calls", async () => {
  core.mockImplementation(async (_argv, io) => {
    io.stdout('{"schema":"paideia.training-cost-plan.v1","modelCallsMade":1}\n');
    return 0;
  });
  await expect(runTraining(options())).rejects.toThrow("required final training receipt");
});

it("abandons a core that ignores cancellation at the command deadline", async () => {
  let lateIO: Parameters<typeof main>[1] | undefined;
  let complete: ((code: number) => void) | undefined;
  const stdout = vi.fn(), stderr = vi.fn();
  core.mockImplementation((_argv, io) => {
    lateIO = io;
    return new Promise(resolve => { complete = resolve; });
  });
  const interruptCount = process.listenerCount("SIGINT"), terminateCount = process.listenerCount("SIGTERM");
  try {
    await expect(runTraining({ ...options(), timeoutMs: 20, streams: { stdout, stderr } }))
      .rejects.toThrow("exceeded its command deadline");
    expect(lateIO?.signal?.aborted).toBe(true);
    lateIO!.stdout('{"schema":"paideia.training-cost-plan.v1","modelCallsMade":0}\n');
    lateIO!.stderr("late diagnostic\n");
    expect(stdout).not.toHaveBeenCalled(); expect(stderr).not.toHaveBeenCalled();
    expect(process.listenerCount("SIGINT")).toBe(interruptCount);
    expect(process.listenerCount("SIGTERM")).toBe(terminateCount);
  } finally { complete?.(0); }
}, 1000);

it("requires isolated actual training and validates repair authority before invoking the core", async () => {
  await expect(runTraining({ ...options(), dryRun: false })).rejects.toThrow("host execution is disabled");
  await expect(runTraining({ ...options(), repairWitness: "/witness" })).rejects.toThrow("--repair-witness requires");
  await expect(runTraining({ ...options(), repairMeasurements: "/parent" })).rejects.toThrow("v2 preparation");
  expect(core).not.toHaveBeenCalled();
});

it("routes v4 image declarations through preparation validation before any training", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-training-v4-")); roots.push(root);
  const file = path.join(root, "launch.json");
  await writeFile(file, JSON.stringify({ version: "spawnfile.training-container.v4", image: {}, slots: 0 }));
  await expect(runTraining({ ...options(), trainingConfig: file, dryRun: false })).rejects.toThrow(/slots/);
  expect(core).not.toHaveBeenCalled();
});

it("rejects an image override owned by a preparation declaration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-training-v2-")); roots.push(root);
  const file = path.join(root, "launch.json"); await writeFile(file, JSON.stringify({ version: "spawnfile.training-container.v2" }));
  await expect(runTraining({ ...options(), trainingConfig: file, trainingImage: "sha256:any" })).rejects.toThrow("owns its image declaration");
});

it("enforces dry-run at the in-process boundary even if its caller omitted the flag", async () => {
  core.mockImplementation(async (argv, io) => {
    expect(argv).toEqual(["train", "--train", "dataset.yaml", "--dry-run"]);
    io.stdout('{"schema":"paideia.training-cost-plan.v1","modelCallsMade":0}\n');
    return 0;
  });
  expect(await runTraining({ ...options(), args: ["--train", "dataset.yaml"] })).toBe(0);
});

it("preserves the line-oriented stream contract for multi-line diagnostics", async () => {
  const stdout = vi.fn(), stderr = vi.fn();
  core.mockImplementation(async (_argv, io) => {
    io.stdout('\n{"schema":"paideia.training-cost-plan.v1","modelCallsMade":0}\r\n\n');
    io.stderr("first\r\n\nsecond");
    return 0;
  });
  expect(await runTraining({ ...options(), streams: { stdout, stderr } })).toBe(0);
  expect(stdout.mock.calls).toEqual([['{"schema":"paideia.training-cost-plan.v1","modelCallsMade":0}']]);
  expect(stderr.mock.calls).toEqual([["first"], ["second"]]);
});

it.each(['{}', 'null', '[]', '{"schema":"wrong","modelCallsMade":0}',
  '{"schema":"paideia.training-cost-plan.v1"}', 'diagnostic'])
("requires the receipt to be the final stdout line: %s", async final => {
  core.mockImplementation(async (_argv, io) => {
    io.stdout('{"schema":"paideia.training-cost-plan.v1","modelCallsMade":0}\n');
    io.stdout(`${final}\n`);
    return 0;
  });
  await expect(runTraining(options())).rejects.toThrow("required final training receipt");
});

it("accepts a receipt split across writes without a trailing newline", async () => {
  const stdout = vi.fn(), stderr = vi.fn();
  core.mockImplementation(async (_argv, io) => {
    io.stdout('diagnostic\n{"schema":"paideia.training-');
    io.stdout('cost-plan.v1","modelCallsMade":0}');
    io.stderr('partial '); io.stderr('diagnostic\nlast diagnostic');
    return 0;
  });
  expect(await runTraining({ ...options(), streams: { stdout, stderr } })).toBe(0);
  expect(stdout.mock.calls).toEqual([['diagnostic'], ['{"schema":"paideia.training-cost-plan.v1","modelCallsMade":0}']]);
  expect(stderr.mock.calls).toEqual([['partial diagnostic'], ['last diagnostic']]);
});

it("rejects completion after synchronous work delayed the deadline timer", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  core.mockImplementation(async (_argv, io) => {
    io.stdout('{"schema":"paideia.training-cost-plan.v1","modelCallsMade":0}\n');
    now = 5001;
    return 0;
  });
  await expect(runTraining(options())).rejects.toThrow("exceeded its command deadline");
});

it("preserves cancellation while flushing a final unterminated receipt", async () => {
  const controller = new AbortController();
  core.mockImplementation(async (_argv, io) => {
    io.stdout('{"schema":"paideia.training-cost-plan.v1","modelCallsMade":0}');
    return 0;
  });
  expect(await runTraining({ ...options(), signal: controller.signal,
    streams: { stdout: () => controller.abort(), stderr() {} } })).toBe(130);
});

it("flushes an unterminated diagnostic when the core throws", async () => {
  const stderr = vi.fn();
  const error = new Error("core failed");
  core.mockImplementation(async (_argv, io) => { io.stderr("partial diagnostic"); throw error; });
  await expect(runTraining({ ...options(), streams: { stdout() {}, stderr } })).rejects.toBe(error);
  expect(stderr).toHaveBeenCalledExactlyOnceWith("partial diagnostic");
});

it("abandons an externally cancelled core even if it ignores the signal", async () => {
  const controller = new AbortController();
  core.mockImplementation(async (_argv, io) => {
    controller.abort(); expect(io.signal?.aborted).toBe(true);
    return new Promise(() => {});
  });
  expect(await runTraining({ ...options(), signal: controller.signal })).toBe(130);
});
