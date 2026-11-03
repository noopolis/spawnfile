import { expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ argv: [] as string[][] }));
vi.mock("../auth/index.js", () => ({ requireAuthProfile: async (name: string) => ({ name }) }));
vi.mock("../compiler/training/trial/index.js", () => ({ createBootedTrialRun: () => ({ close: async () => undefined }) }));
vi.mock("../runtime/daimon/training/booted/index.js", () => ({ bindBootedJudges: () => undefined, createDaimonBootedAdapter: () => ({}) }));
vi.mock("../runtime/trainingCli.js", () => ({ main: async (argv: string[]) => { calls.argv.push(argv); return 0; } }));

const { runBootedTraining } = await import("./trainingBooted.js");

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
