import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defaultTrainingOutputRoot } from "../compiler/training/output.js";
import { cleanTrainingProjects, optimizer, writeTrainingFile } from "../compiler/training/plan/fixtures.test-helper.js";
import { executionFixture } from "../compiler/training/execution.test-helper.js";
import { runCli } from "./runCli.js";

afterEach(cleanTrainingProjects);
it("prints a complete lowered dry-run without auth, Docker, delegation, context or allocation", async () => {
  const root = await executionFixture(), stdout: string[] = [], stderr: string[] = [];
  const forbidden = vi.fn(async () => { throw Error("dry-run mutation/execution"); });
  const before = await readdir(root);
  expect(await runCli(["train", root, "--agent", "writer", "--dry-run"], {
    handlers: { runTraining: forbidden, createTrainingContext: forbidden, allocateTrainingOutputParent: forbidden },
    streams: { stdout: value => stdout.push(value), stderr: value => stderr.push(value) }
  }), "dry-run isolation guarantee").toBe(0);
  expect(stderr).toEqual([]); expect(stdout).toHaveLength(1); expect(forbidden).not.toHaveBeenCalled();
  const plan = JSON.parse(stdout[0]!);
  expect(plan).toMatchObject({ version: "spawnfile.training-execution.v1", optimizer, authoring: { agent: { id: "agent:writer" } } });
  expect(plan.args).toContain(path.join(root, "training/train.yaml"));
  expect(plan.output.startsWith(path.join(defaultTrainingOutputRoot(root), "agent%3Awriter") + path.sep)).toBe(true);
  expect(await readdir(root)).toEqual(before);
});
it("hands the lowered authored execution to production-booted training with explicit overrides kept", async () => {
  const root = await executionFixture();
  const delegate = vi.fn(async () => 0);
  const output = path.join(root, "chosen-output");
  expect(await runCli(["train", root, "--agent", "writer", "--train", path.join(root, "training/test.yaml"),
    "--out", output, "--optimizer-model", "override", "--auth-profile", "training"], {
    handlers: { runTraining: delegate }, streams: { stdout() {}, stderr() {} }
  })).toBe(0);
  expect(delegate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ authProfile: "training", dryRun: false,
    args: expect.arrayContaining(["--train", path.join(root, "training/test.yaml"), "--out", output, "--optimizer-model", "override"]) }));
});
it("refuses actual training for a subject that is not a Daimon agent", async () => {
  const root = await executionFixture(), stderr: string[] = [];
  const spawnfile = path.join(root, "Spawnfile");
  await writeTrainingFile(root, "Spawnfile", (await readFile(spawnfile, "utf8")).replace("runtime: daimon", "runtime: openclaw"));
  const delegate = vi.fn(async () => 0);
  expect(await runCli(["train", root, "--agent", "writer", "--out", path.join(root, "out")], {
    handlers: { runTraining: delegate }, streams: { stdout() {}, stderr: value => stderr.push(value) }
  })).toBe(2);
  expect(stderr.join("\n")).toContain("boots Daimon trials");
  expect(delegate).not.toHaveBeenCalled();
});
