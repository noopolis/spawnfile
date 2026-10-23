import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runCli } from "./runCli.js";
import type { RunTrainingOptions } from "./trainingExecution.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.each([
  [[], 60_000_000],
  [["--timeout-ms", "5000"], 5000],
  [["--experiment-timeout-ms", "70000000"], 70_000_000],
  [["--timeout-ms", "5000", "--experiment-timeout-ms", "70000000"], 70_000_000]
])("propagates authored independent deadlines and honors explicit experiment flags: %j", async (flags, experimentMs) => {
  const root = await mkdtemp(path.join(tmpdir(), "spawnfile-deadlines-")); roots.push(root);
  await writeFile(path.join(root, "Spawnfile"), `spawnfile_version: "0.1"
kind: agent
name: author
runtime: daimon
training:
  deadlines: { experiment_ms: 60000000, trial_ms: 5000000 }
`);
  const delegate = vi.fn(async (_options: RunTrainingOptions) => 0);
  expect(await runCli(["train", root, "--train", "train.yaml", "--dry-run", ...flags], {
    handlers: { runTraining: delegate }, streams: { stdout() {}, stderr() {} }
  })).toBe(0);
  const options = delegate.mock.calls[0]![0];
  expect(options.timeoutMs, "outer experiment deadline guarantee").toBe(experimentMs + 5000);
  expect(options.args, "inner experiment deadline guarantee").toEqual(expect.arrayContaining(flags.length ? flags : ["--experiment-timeout-ms", "60000000"]));
  expect(options.args).toEqual(expect.arrayContaining(["--trial-timeout-ms", "5000000"]));
  delegate.mockClear();
  expect(await runCli(["train", root, "--train", "train.yaml", "--dry-run", ...flags, "--trial-timeout-ms", "2000"], {
    handlers: { runTraining: delegate }, streams: { stdout() {}, stderr() {} }
  })).toBe(0);
  expect(delegate.mock.calls[0]![0].args).toEqual(expect.arrayContaining(["--trial-timeout-ms", "2000"]));
  expect(delegate.mock.calls[0]![0].args).not.toContain("5000000");
});

it.each(["--experiment-timeout-ms", "--trial-timeout-ms"])("validates %s before reading the project", async flag => {
  const forbidden = vi.fn(async () => { throw new Error("must not read"); });
  for (const value of ["0", "1.5", "NaN", "604800001"]) {
    expect(await runCli(["train", "/missing", "--train", "train.yaml", flag, value], {
      handlers: { loadTrainingProject: forbidden, runTraining: forbidden }, streams: { stdout() {}, stderr() {} }
    })).toBe(2);
  }
  expect(forbidden).not.toHaveBeenCalled();
});
