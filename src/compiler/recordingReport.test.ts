import path from "node:path";
import { readFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";

import { parseDistributionReport } from "../distribution/index.js";
import { capableDaimonManifest } from "../runtime/daimon/recording.test-helper.js";
import { buildCompilePlan } from "./buildCompilePlan.js";
import { compileProject } from "./compileProject.js";
import { createMemoryArtifactBundle } from "./memoryArtifacts.js";
import { resolveRecordingReport } from "./recordingReport.js";
import { cleanTrainingProjects, trainingProject, writeTrainingFile } from "./training/plan/fixtures.test-helper.js";

afterEach(cleanTrainingProjects);
const memory = (id: string) => ({ id, store: { kind: "json", path: `/data/${id}/events.jsonl` } });
const agent = (name: string, training?: unknown) => ({ spawnfile_version: "0.1", kind: "agent", name, runtime: "daimon", memory: [memory(name)], ...(training ? { training } : {}) });

it("uses only compiled recording agents, protecting their own and accessible shared memory mounts", async () => {
  const team = { spawnfile_version: "0.1", kind: "team", name: "news", mode: "swarm", memory: [memory("shared")],
    members: ["a", "b"].map((id) => ({ id, ref: id })) };
  const root = await trainingProject({ Spawnfile: team, "a/Spawnfile": agent("a", { record: {} }), "b/Spawnfile": agent("b") });
  const plan = await buildCompilePlan(root), memories = createMemoryArtifactBundle(plan).memories;
  const expected = memories.filter((entry) => ["a", "shared"].includes(entry.id)).map((entry) => entry.store.persistent_mount_id!).sort();
  expect(expected).toHaveLength(2);
  expect(resolveRecordingReport(plan, memories)).toMatchObject({ keep_ms: 30 * 86_400_000, memory_mount_ids: expected, recording_mount_ids: ["daimon-recording-a"] });
  await writeTrainingFile(root, "Spawnfile", { ...team, shared: { training: { record: { keep: "60d" } } } });
  const inherited = await buildCompilePlan(root);
  expect(resolveRecordingReport(inherited, createMemoryArtifactBundle(inherited).memories)).toMatchObject({
    keep_ms: 60 * 86_400_000, memory_mount_ids: memories.map((entry) => entry.store.persistent_mount_id!).sort(),
    recording_mount_ids: ["daimon-recording-a", "daimon-recording-b"]
  });
});

it("emits the opt-in field in real compile and distribution reports without loading training targets", async () => {
  const root = await trainingProject({ Spawnfile: agent("a") });
  const off = await compileProject(root);
  expect(off.report).not.toHaveProperty("recording");
  // Use the compiler's emitted report path, which the Dockerfile copies into the image.
  const { DISTRIBUTION_REPORT_OUTPUT_FILE } = await import("../distribution/index.js");
  const emitted = path.join(off.outputDirectory, DISTRIBUTION_REPORT_OUTPUT_FILE);
  expect(JSON.parse(await readFile(emitted, "utf8"))).not.toHaveProperty("recording");
  await writeTrainingFile(root, "Spawnfile", agent("a", { record: {}, graders: { writing: "missing.yaml" },
    targets: [{ files: ["missing.md"], grader: "writing", datasets: { train: "missing-train.yaml", test: "missing-test.yaml" } }] }));
  const on = await compileProject(root, { daimonContractManifest: capableDaimonManifest() });
  const distribution = parseDistributionReport(JSON.parse(await readFile(emitted, "utf8")));
  expect(on.report.recording).toMatchObject({ keep_ms: 30 * 86_400_000, recording_mount_ids: ["daimon-recording-a"],
    memory_mount_ids: on.report.container!.memory!.map((entry) => entry.store.persistent_mount_id) });
  expect(distribution.recording).toEqual(on.report.recording);
  expect(distribution.workspace_git_resources).toEqual([]);
  expect(distribution.workspace_bundles).toEqual([]);
  expect(JSON.stringify(distribution)).not.toContain(root);
});
