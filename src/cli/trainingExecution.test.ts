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
