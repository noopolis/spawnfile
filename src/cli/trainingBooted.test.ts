import { expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ argv: [] as string[][], dependencies: [] as unknown[], closed: 0, hang: false }));
vi.mock("../runtime/daimon/training/trial/run.js", () => ({ openTrainingRun: async () => ({ run: {}, close: async () => { calls.closed++; } }) }));
vi.mock("../runtime/daimon/training/booted/index.js", () => ({ createDaimonBootedAdapter: () => ({}) }));
vi.mock("../runtime/trainingCli.js", () => ({ main: async (argv: string[], io: { signal: AbortSignal }, dependencies: unknown) => {
  calls.argv.push(argv); calls.dependencies.push(dependencies);
  // A run that only ends when cancelled, as the training core does on its signal.
  if (calls.hang) await new Promise((resolve) => io.signal.addEventListener("abort", resolve, { once: true }));
  return calls.hang ? 1 : 0; } }));

const { runBootedTraining } = await import("./trainingBooted.js");
const { momentPreparation } = await import("../compiler/training/trial/index.js");

const run = (args: string[], agent: { model: { name: string } | null; engine: string | null }) => runBootedTraining({
  args, authProfile: "training", dryRun: false, timeoutMs: 1, streams: { stdout: () => undefined, stderr: () => undefined },
  context: { project: { root: "/p" }, documents: [{ role: "system", destinationPath: "AGENTS.md" }],
    agent: { id: "agent:writer", source: "/p/Spawnfile", runtime: "daimon", ...agent } } as never
});

it("labels trials with the subject's own model, the engine when it pins none, and keeps an explicit model", async () => {
  await run(["--out", "/o"], { model: { name: "gpt-5.6-terra" }, engine: "codex" });
  await run(["--out", "/o"], { model: null, engine: "agy" });
  await run(["--out", "/o", "--model", "chosen"], { model: { name: "gpt-5.6-terra" }, engine: "codex" });
  const model = (argv: string[]) => argv.filter((_, index) => argv[index - 1] === "--model");
  expect(calls.argv.map(model)).toEqual([["gpt-5.6-terra"], ["agy"], ["chosen"]]);
});

it("registers the moment preparation, which admits a valid moment and nothing beside it", async () => {
  await run(["--out", "/o"], { model: null, engine: "codex" });
  const dependencies = calls.dependencies.at(-1) as { prepareEnvironment: () => Promise<unknown> };
  expect(dependencies).toMatchObject({ preparations: { "spawnfile/moment": momentPreparation }, unlockedSetupPaths: ["moment"] });
  expect(await dependencies.prepareEnvironment()).toEqual({});
  const moment = { version: "spawnfile.training-moment.v1", at: "2026-10-05T11:45:40.170Z",
    wake: { surface: "moltnet", room: "assignment", from: "brass", text: "@writer" }, resources: [{ id: "state", fill: { kind: "empty" } }] };
  expect(() => momentPreparation.validate({ moment }, "record.a.setup")).not.toThrow();
  expect(() => momentPreparation.validate({ moment, other: 1 }, "record.a.setup")).toThrow("sets only setup.moment");
  expect(() => momentPreparation.validate({ moment: { ...moment, at: "yesterday" } }, "record.a.setup")).toThrow("record.a.setup.moment");
});

it("cancels the run on SIGINT, tears it down and releases the realm, and exits 130", async () => {
  calls.hang = true;
  const before = calls.closed;
  const running = run(["--out", "/o"], { model: null, engine: "codex" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.emit("SIGINT");
  expect(await running).toBe(130);
  expect(calls.closed).toBe(before + 1);
  expect(process.listenerCount("SIGINT")).toBe(0);
  calls.hang = false;
});
