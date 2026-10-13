import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { capableDaimonManifest } from "../runtime/daimon/recording.test-helper.js";
import { compileProject } from "./compileProject.js";
import { cleanTrainingProjects, trainingProject, writeTrainingFile } from "./training/plan/fixtures.test-helper.js";

afterEach(async () => { vi.useRealTimers(); await cleanTrainingProjects(); });
const agent = (runtime: string, recording = true) => ({
  spawnfile_version: "0.1", kind: "agent", name: "writer", runtime,
  ...(recording ? { training: { record: { keep: "2h", volumes: ["state"] } } } : {}),
  workspace: { resources: [{ id: "state", kind: "volume", mode: "mutable", mount: "./state" }] }
});

it.each(["openclaw", "picoclaw", "pi"])("rejects recording for %s with the exact agent and runtime", async (runtime) => {
  const root = await trainingProject({ Spawnfile: agent(runtime) });
  await expect(compileProject(root)).rejects.toMatchObject({ code: "validation_error",
    message: expect.stringMatching(new RegExp(`agent:writer.*runtime ${runtime}`, "u")) });
});

it("compiles recording against the actual pinned image", async () => {
  const root = await trainingProject({ Spawnfile: agent("daimon") });
  const result = await compileProject(root);
  expect(result.report.recording?.recording_mount_ids).toEqual(["daimon-recording-writer"]);
});

it("rejects recording against an explicitly incapable manifest and requires a release and re-pin", async () => {
  const root = await trainingProject({ Spawnfile: agent("daimon") });
  const manifest = { ...capableDaimonManifest() };
  delete manifest.wakeMoments;
  await expect(compileProject(root, { daimonContractManifest: manifest })).rejects.toMatchObject({ code: "validation_error", message: expect.stringContaining(
    "pinned Daimon runtime image does not declare the wakeMoments capability; a Daimon release with it and a runtimes.yaml / contract-manifest re-pin are required"
  ) });
});

it("compiles an injected capable contract, emits snapshots at their mounted backing path, and protects the store", async () => {
  const root = await trainingProject({ Spawnfile: agent("daimon") });
  const result = await compileProject(root, { daimonContractManifest: capableDaimonManifest() });
  const config = JSON.parse(await readFile(path.join(result.outputDirectory,
    "container/rootfs/var/lib/spawnfile/instances/daimon/daimon-organization/daimon/daimon-organization-runtime.json"), "utf8"));
  const recording = config.agents[0].recording;
  expect(recording).toEqual({ directory: "/var/lib/spawnfile/recording/writer", keepMs: 7_200_000,
    snapshots: [{ id: "state", path: expect.stringMatching(/^\/var\/lib\/spawnfile\/resources\/instances\//u) }] });
  const mounts = result.report.container!.persistent_mounts!;
  expect(mounts).toContainEqual(expect.objectContaining({ mount_path: recording.snapshots[0].path, lifecycle: "exclusive-reattach" }));
  expect(mounts).toContainEqual(expect.objectContaining({ id: "daimon-recording-writer", mount_path: recording.directory, lifecycle: "exclusive-reattach" }));
  expect(result.report.recording?.recording_mount_ids).toEqual(["daimon-recording-writer"]);
});

const emittedFiles = async (directory: string, relative = ""): Promise<Array<{ file: string; bytes: Buffer }>> => {
  const result: Array<{ file: string; bytes: Buffer }> = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await emittedFiles(directory, file));
    else result.push({ file, bytes: await readFile(path.join(directory, file)) });
  }
  return result.sort((a, b) => a.file.localeCompare(b.file));
};

it("keeps every non-recording artifact byte-identical with or without a capable manifest and training metadata", async () => {
  const manifest = agent("daimon", false);
  const root = await trainingProject({ Spawnfile: manifest });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-09T08:20:31Z"));
  const before = await compileProject(root);
  const bytes = await emittedFiles(before.outputDirectory);
  await writeTrainingFile(root, "Spawnfile", { ...manifest, training: { graders: { writing: "missing.yaml" } } });
  const after = await compileProject(root, { daimonContractManifest: capableDaimonManifest() });
  expect(await emittedFiles(after.outputDirectory)).toEqual(bytes);
  expect(after.report).toEqual(before.report);
  expect(after.report).not.toHaveProperty("recording");
});
