import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { lowerTrainingMoments, materializeTrainingCase, type TrainingMomentCase } from "./moments.js";
import { loadTrainingProject, resolveTrainingPlan } from "./plan/index.js";
import { agentManifest, cleanTrainingProjects, dataFiles, example, target, training, trainingProject, writeTrainingFile } from "./plan/fixtures.test-helper.js";
import { rewindFixture } from "./rewind/fixtures.test-helper.js";

afterEach(cleanTrainingProjects);
const fakeCase = async () => ({ checks: [{ id: "accepted", eval: "json-schema", input: "output", schema: { type: "string" } }] });
const fixture = async () => {
  const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest({ training: { ...training,
    preparation: { hook: "fixture/prepare", history: "history" },
    targets: [{ ...target, datasets: { ...target.datasets, validation: "training/validation.yaml" } }] } }),
    "training/validation.yaml": { examples: [{ ...example, id: "valid", at: "2026-10-08T00:00:00Z" }] },
    "training/test.yaml": { examples: [{ ...example, id: "held-out", at: "2026-10-07T00:00:00Z" }] } });
  await mkdir(path.join(root, "history"));
  const project = await loadTrainingProject(root), plan = resolveTrainingPlan(project, "writer", "test");
  return { root, project, plan, out: path.join(root, "lowered"), prepareCase: fakeCase };
};
const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));

it("lowers every split through real rewind and a fake hook, preserving identity and provenance", async () => {
  const f = await fixture(), calls: string[] = [];
  const result = await lowerTrainingMoments({ ...f, prepareCase: async context => {
    calls.push(`${context.role}:${context.example.id}`);
    expect(await json(path.join(context.momentRoot, "moment.json"))).toEqual(context.moment);
    return { setup: { fixture: true }, outputs: { answer: "answer.txt" }, ...(await fakeCase()) };
  } });
  expect(calls).toEqual([`train:${example.id}`, "validation:valid", "test:held-out"]);
  expect(result.report.entries.every(entry => entry.status === "materialized")).toBe(true);
  for (const role of ["train", "validation", "test"] as const) {
    const dataset = await json(result.datasets[role]!);
    const entry = result.report.entries.find(value => value.role === role)!;
    expect(dataset.schema).toBe("spawnfile.training.dataset.v1");
    expect(dataset.subject).toBe(f.plan.agent.name);
    expect(dataset.setup).toEqual({ profile: "fixture/prepare" });
    const record = dataset.records[0];
    expect(record, "lineage handoff guarantee").toMatchObject({ id: entry.id, group: entry.group, lineage: [entry.lineage] });
    expect(record.setup.trainingMoment, "moment identity guarantee").toMatchObject({ version: "spawnfile.training-moment-case.v1",
      agent: f.plan.agent.id, role, example: `${role}:${entry.id}`, at: entry.moment!.at, effectiveAt: entry.moment!.effectiveAt,
      wake: entry.wake, dataset: entry.dataset, historyDir: path.join(f.root, "history"), hook: "fixture/prepare" });
    expect(record.context.trainingMomentProvenance).toEqual(entry.moment);
    expect(record.input.message).toEqual({ network: entry.wake.surface, sender: entry.wake.from, target: entry.wake.room, text: entry.wake.text });
  }
  expect(await json(path.join(f.out, "lowering.json"))).toEqual(result.report);
});

it("reports rewind and hook refusals without replacement, including an all-refused split", async () => {
  const f = await fixture();
  await writeTrainingFile(f.root, "training/train.yaml", { examples: [example,
    { ...example, id: "outside-range", at: "1969-12-31T23:59:59Z" }, { ...example, id: "hook-refuses" }] });
  f.project = await loadTrainingProject(f.root); f.plan = resolveTrainingPlan(f.project, "writer", "test");
  const result = await lowerTrainingMoments({ ...f, prepareCase: async ({ example: selected }) => {
    if (selected.id === "hook-refuses") throw new Error("Missing historical hook evidence");
    return fakeCase();
  } });
  expect((await json(result.datasets.train)).records.map((record: { id: string }) => record.id), "refusal skip guarantee").toEqual([example.id]);
  expect(result.report.entries.filter(entry => entry.status === "refused").map(entry => entry.reason))
    .toEqual(expect.arrayContaining([expect.stringContaining("must be within 1970"), "Missing historical hook evidence"]));
  await expect(lowerTrainingMoments({ ...f, out: path.join(f.root, "all-refused"), prepareCase: async () => { throw new Error("No evidence"); } }))
    .rejects.toThrow("No executable train moments");
  expect((await json(path.join(f.root, "all-refused/lowering.json"))).entries.every((entry: { status: string }) => entry.status === "refused")).toBe(true);
});

it.each([false, true])("%s: reports an unsupported timestamp before continuing or failing an all-refused split", async allRefused => {
  const f = await fixture();
  const refused = { ...example, id: "a-unsupported-precision", at: "2026-10-09T10:00:00.1234567890Z" };
  await writeTrainingFile(f.root, "training/train.yaml", { examples: allRefused ? [refused] : [refused, example] });
  // Loading through the real schema proves this is a lowering refusal, not invalid authoring.
  f.project = await loadTrainingProject(f.root); f.plan = resolveTrainingPlan(f.project, "writer", "test");
  const calls: string[] = [];
  const attempt = await lowerTrainingMoments({ ...f, prepareCase: async ({ example: selected }) => {
    calls.push(selected.id); return fakeCase();
  } }).catch((error: Error) => error);
  if (allRefused) {
    expect(attempt, "timestamp refusal boundary guarantee").toBeInstanceOf(Error);
    expect((attempt as Error).message, "timestamp refusal boundary guarantee").toContain("No executable train moments");
  } else {
    expect(attempt, "timestamp refusal boundary guarantee").not.toBeInstanceOf(Error);
  }
  const report = await json(path.join(f.out, "lowering.json"));
  expect(report.entries[0]).toMatchObject({ id: refused.id, role: "train", dataset: f.plan.targets[0]!.datasets.train.path,
    at: refused.at, wake: refused.wake, status: "refused", lineage: null,
    reason: expect.stringContaining("at most nanosecond precision is required") });
  expect(report.entries[0].moment).toBeUndefined();
  expect(report.entries.map((entry: { id: string }) => entry.id))
    .toEqual(allRefused ? [refused.id, "valid", "held-out"] : [refused.id, example.id, "valid", "held-out"]);
  expect(calls).toEqual(allRefused ? ["valid", "held-out"] : [example.id, "valid", "held-out"]);
  expect((await json(path.join(f.out, "train.spawnfile-training.json"))).records.map((record: { id: string }) => record.id))
    .toEqual(allRefused ? [] : [example.id]);
  expect(report.entries.slice(1).every((entry: { status: string }) => entry.status === "materialized")).toBe(true);
});

it("uses per-example overrides and deduplicates repeated target references", async () => {
  const f = await rewindFixture();
  const trainExample = f.project.datasets[f.plan.targets[0]!.datasets.train.sourcePath]!.value.examples[0]!;
  await writeTrainingFile(f.root, "training/test.yaml", { examples: [{ ...trainExample, id: "held-out" }] });
  await writeTrainingFile(f.root, "training/train.yaml", { examples: [trainExample, { ...example, id: "unrewindable" }] });
  const project = await loadTrainingProject(f.root), plan = resolveTrainingPlan(project, "a", "test");
  plan.targets.push(structuredClone(plan.targets[0]!));
  const result = await lowerTrainingMoments({ project, plan, out: path.join(f.root, "lowered"), historyDir: f.historyDir, prepareCase: fakeCase });
  expect(result.report.entries).toHaveLength(3);
  expect((await json(result.datasets.train)).records.map((record: { id: string }) => record.id), "rewind refusal guarantee").toEqual([trainExample.id]);
  expect(result.report.entries.find(entry => entry.id === "unrewindable")!.status).toBe("refused");
  expect(result.report.entries[0]!.moment!.inputs.find(input => input.section === "networks"))
    .toMatchObject({ fidelity: "overridden", refusal: null });
});

it("rewinds independently on each trial and refuses altered historical identity", async () => {
  const f = await fixture(), result = await lowerTrainingMoments(f);
  const record = (await json(result.datasets.train)).records[0];
  const moment = record.setup.trainingMoment as TrainingMomentCase;
  // Training parsing reconstructs property order; wake identity is semantic exactness.
  moment.wake = { surface: moment.wake.surface, room: moment.wake.room, from: moment.wake.from, text: moment.wake.text };
  const first = path.join(f.root, "trial-one"), second = path.join(f.root, "trial-two");
  const attempt = await materializeTrainingCase({ ...f, moment, out: first }).catch((error: Error) => error);
  expect(attempt, "fresh rewind destination guarantee").not.toBeInstanceOf(Error);
  await writeFile(path.join(first, "subject-mutated"), "do not reuse");
  await materializeTrainingCase({ ...f, moment, out: second });
  expect(await readdir(second), "fresh trial rewind guarantee").not.toContain("subject-mutated");
  await expect(materializeTrainingCase({ ...f, moment, out: first })).rejects.toThrow("empty directory");
  await expect(materializeTrainingCase({ ...f, moment: { ...moment, wake: { ...moment.wake, text: "invented wake" } }, out: path.join(f.root, "bad-wake") }))
    .rejects.toThrow("wake or instant");
  await expect(materializeTrainingCase({ ...f, moment: { ...moment, effectiveAt: "2026-10-09T08:20:32.000Z" }, out: path.join(f.root, "bad-start") }))
    .rejects.toThrow("provenance differs from lowering");
});

it("shares lineage across clones of a historical moment even with different IDs and offset spelling", async () => {
  const f = await fixture();
  await writeTrainingFile(f.root, "training/test.yaml", { examples: [{ ...example, id: "renamed", at: "2026-10-09T08:20:31Z" }] });
  f.project = await loadTrainingProject(f.root); f.plan = resolveTrainingPlan(f.project, "writer", "test");
  const result = await lowerTrainingMoments(f);
  expect(result.report.entries.filter(entry => entry.role !== "validation").map(entry => entry.lineage), "historical lineage guarantee")
    .toEqual([result.report.entries[0]!.lineage, result.report.entries[0]!.lineage]);
});

it("refuses trial provenance drift after a historical input changes", async () => {
  const f = await fixture(), result = await lowerTrainingMoments(f);
  const moment = (await json(result.datasets.train)).records[0].setup.trainingMoment as TrainingMomentCase;
  const expected = await json(path.join(moment.momentRoot, "moment.json"));
  expected.record = { matched: true, attempts: 1, selectedStartedAt: moment.effectiveAt,
    executionId: "different-original", selection: "earliest-startedAt" };
  const attempted = await materializeTrainingCase({ ...f, moment, expected, out: path.join(f.root, "drifted") }).catch((error: Error) => error);
  expect(attempted, "trial provenance guarantee").toBeInstanceOf(Error);
  expect((attempted as Error).message).toBe("Trial rewind provenance differs from accepted lowering");
});

it("combines distinct declared datasets in each role instead of choosing one target", async () => {
  const f = await fixture();
  await writeTrainingFile(f.root, "training/second.yaml", { examples: [{ ...example, id: "second-example" }] });
  // Add the authored second dataset through a real target declaration and reload its bytes.
  await writeTrainingFile(f.root, "Spawnfile", agentManifest({ training: { ...training,
    targets: [target, { ...target, datasets: { ...target.datasets, train: "training/second.yaml" } }] } }));
  const project = await loadTrainingProject(f.root), plan = resolveTrainingPlan(project, "writer", "test");
  const result = await lowerTrainingMoments({ project, plan, out: f.out, prepareCase: fakeCase });
  expect((await json(result.datasets.train)).records.map((record: {id:string}) => record.id), "all declared datasets guarantee")
    .toEqual(expect.arrayContaining([example.id, "second-example"]));
  expect(result.report.entries).toHaveLength(3);
});
