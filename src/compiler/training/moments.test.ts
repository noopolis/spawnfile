import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

import { lowerTrainingMoments, resumedMomentDatasets, trainingMomentSchema, withLoweredDatasets } from "./moments.js";
import { loadTrainingProject, resolveTrainingPlan } from "./plan/index.js";
import { agentManifest, cleanTrainingProjects, dataFiles, example, training, trainingProject, writeTrainingFile } from "./plan/fixtures.test-helper.js";

const run = promisify(execFile);
const outs: string[] = [];
afterEach(async () => {
  await cleanTrainingProjects();
  await Promise.all(outs.splice(0).map((out) => rm(out, { recursive: true, force: true })));
});

const project = async (train: Record<string, unknown>[]) => {
  const resources = ["research-corpus", "edition-state", "tools"].map((id) => ({ id, kind: "volume", mount: `./${id}`, mode: "mutable" }));
  const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest({ workspace: { docs: { system: "AGENTS.md" }, resources } }),
    "training/train.yaml": { after_boot: [{ user: "0:0", command: ["node", "token.mjs"] }], examples: train },
    "grading/case-a/grader.yaml": "case grader\n", "grading/case-a/grounding.md": "The ramp is empty.\n" });
  await writeTrainingFile(root, "corpus/2026-10-05/desks/writer.index", "row\n");
  for (const args of [["init", "-q"], ["add", "corpus"], ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-qm", "c"]]) {
    await run("git", ["-C", root, ...args]);
  }
  const loaded = await loadTrainingProject(root);
  const out = await mkdtemp(path.join(os.tmpdir(), "spawnfile-moments-out-")); outs.push(out);
  return { root, loaded, plan: resolveTrainingPlan(loaded, undefined, "test"), out };
};

it("lowers each moment into a record with its pinned state, production-shaped wake, case grader and output", async () => {
  const { root, loaded, plan, out } = await project([{
    ...example, id: "case-a", grader: "../grading/case-a/grader.yaml", context: { grounding: { file: "../grading/case-a/grounding.md" } },
    output: "state/edition/filings/s-1/1.json",
    resources: [
      { id: "research-corpus", kind: "volume", name: "corpus", mount: "./repos/corpus", mode: "mutable", sharing: "team",
        feed: { git: { repo: "..", ref: "HEAD", paths: ["corpus/2026-10-05"], fetch: false }, keep: 3 } },
      { id: "edition-state", kind: "volume", mount: "./state/edition", mode: "mutable", files: { "seed.json": "{}" } },
      { id: "tools", kind: "volume", mount: "./tools", mode: "mutable" }
    ]
  }, { ...example, id: "plain" }]);
  const datasets = await lowerTrainingMoments({ project: loaded, plan, out });
  const train = JSON.parse(await readFile(datasets.train, "utf8"));
  expect(train.schema).toBe("spawnfile.training.dataset.v1");
  expect(train.setup).toEqual({ profile: "spawnfile/moment" });
  const [moment, plain] = train.records;
  expect(moment).toMatchObject({ id: "case-a", input: { prompt: "[room assignment] brass\n@writer report" },
    context: { grounding: "The ramp is empty.\n" }, outputs: { output: "state/edition/filings/s-1/1.json" },
    checks: [{ id: "grade", eval: "grader", input: "artifact:output", context: { grounding: "context:grounding" } }] });
  const parsed = trainingMomentSchema.parse(moment.setup.moment);
  expect(parsed.at).toBe("2026-10-09T08:20:31.000Z");
  expect(parsed.afterBoot).toEqual([{ user: "0:0", command: ["node", "token.mjs"] }]);
  const head = (await run("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  expect(parsed.resources.map((resource) => resource.fill.kind), "moment state guarantee").toEqual(["git", "files", "empty"]);
  expect(parsed.resources[0]!.fill).toMatchObject({ commit: head, paths: ["corpus/2026-10-05"], repo: root });
  // The case grader is copied beside the dataset, so it stays a contained relative path; the plain case uses the target's.
  expect(await readFile(path.join(path.dirname(datasets.train), moment.checks[0].grader), "utf8"), "case grader guarantee").toBe("case grader\n");
  expect(plain).toMatchObject({ input: { prompt: "[room assignment] brass\n@writer report" }, checks: [{ input: "artifact:reply" }] });
  expect(plain.outputs).toBeUndefined();
  expect(await readFile(path.join(path.dirname(datasets.train), plain.checks[0].grader), "utf8")).toBe(dataFiles["training/writing.grader.yaml"]);
  expect(moment.group).not.toBe(plain.group);
  expect(resumedMomentDatasets(out, plan)).toEqual(datasets);
  await expect(lowerTrainingMoments({ project: loaded, plan, out })).rejects.toThrow("already exist");
});

it("carries a declared optimizer provider to the core as the train dataset's training block", async () => {
  const { loaded, plan, out } = await project([{ ...example, id: "case-a" }]);
  const datasets = await lowerTrainingMoments({ project: loaded, plan: { ...plan, optimizer: { ...plan.optimizer!, provider: "codex-subscription" } }, out });
  expect(JSON.parse(await readFile(datasets.train, "utf8")).training).toEqual({
    models: { optimizer: { provider: "codex-subscription", model: plan.optimizer!.model } },
    optimizer: { model: "optimizer", method: "gepa", variants: plan.optimizer!.variants, keep: plan.optimizer!.keep, budget: { rounds: plan.optimizer!.budget.rounds } } });
  expect(JSON.parse(await readFile(datasets.test, "utf8")).training).toBeUndefined();
});

it("replaces the authored locators with the lowered datasets", () => {
  expect(withLoweredDatasets(["--train", "/a.yaml", "--test", "/b.yaml", "--out", "/o"], { train: "/t.json", test: "/s.json" }))
    .toEqual(["--out", "/o", "--train", "/t.json", "--test", "/s.json"]);
});

it("refuses a grader or context file outside the project", async () => {
  const { loaded, plan, out } = await project([{ ...example, context: { grounding: { file: "../../outside.md" } } }]);
  await expect(lowerTrainingMoments({ project: loaded, plan, out })).rejects.toThrow("context grounding");
});

it("lowers an example's declared checks, weights and gate into one scored stage beside its grade", async () => {
  const { loaded, plan, out } = await project([{ ...example, id: "case-a", output: "filing.json",
    context: { grounding: { file: "../grading/case-a/grounding.md" } },
    checks: [
      { id: "filed", eval: "json-schema", input: "artifact:output", schema: { type: "object", required: ["body"] } },
      { id: "length", eval: "word-count", input: "artifact:output#/body", ignore: ["\\[E\\d+\\]"], min: 200, max: 400 },
      { id: "values", eval: "values-in-source", input: ["artifact:output#/body"], source: ["context:grounding", { file: "../grading/case-a/grounding.md" }], max_missing: 0 }
    ],
    score: { grade: 0.7, length: 0.15, values: 0.15 }, gate: ["filed"] }]);
  const datasets = await lowerTrainingMoments({ project: loaded, plan, out });
  const [record] = JSON.parse(await readFile(datasets.train, "utf8")).records;
  expect(record.checks).toBeUndefined();
  const [stage] = record.stages;
  expect(stage).toMatchObject({ id: "record-checks", score: { linear: { grade: 0.7, length: 0.15, values: 0.15 } }, gate: { all: [{ passed: "filed" }] } });
  expect(stage.checks.map((check: { id: string }) => check.id)).toEqual(["grade", "filed", "length", "values"]);
  expect(stage.checks[2]).toEqual({ id: "length", eval: "word-count", input: "artifact:output#/body", ignore: ["\\[E\\d+\\]"], min: 200, max: 400 });
  // A sidecar source is copied beside the dataset and named by its contained relative path.
  const [, sidecar] = stage.checks[3].source;
  expect(sidecar).toMatch(/^sidecars\/[0-9a-f]{16}\/grounding\.md$/u);
  expect(await readFile(path.join(path.dirname(datasets.train), sidecar), "utf8")).toBe("The ramp is empty.\n");
});

it("refuses weights or gates over undeclared checks", async () => {
  await expect(project([{ ...example, id: "case-a", score: { grade: 1, length: 1 } }])).rejects.toThrow(/undeclared check: length/u);
  await expect(project([{ ...example, id: "case-a", checks: [{ id: "grade", eval: "word-count", input: "artifact:reply", min: 1 }] }])).rejects.toThrow(/grader's/u);
});

const verifierProject = async (trainingExtra: Record<string, unknown>, examples: Record<string, unknown>[]) => {
  const root = await trainingProject({ ...dataFiles, Spawnfile: agentManifest({ training: { ...training, ...trainingExtra } }),
    "training/train.yaml": { examples }, "grading/questions.yaml": "bank bytes\n", "grading/evidence.json": "[{\"source\":\"a\"}]\n",
    "grading/broken.json": "not json", "docs/WRITING.md": "Length follows the facts.\n" });
  const loaded = await loadTrainingProject(root);
  const out = await mkdtemp(path.join(os.tmpdir(), "spawnfile-moments-out-")); outs.push(out);
  return { loaded, out, plan: () => resolveTrainingPlan(loaded, undefined, "test") };
};
const questionnaireExample = { ...example, id: "case-a", output: "filing.json", context: { evidence: { file: "../grading/evidence.json", json: true } },
  checks: [{ id: "house-rules", eval: "questionnaire", bank: "../grading/questions.yaml", context: ["evidence"] }], score: { grade: 0.3, "house-rules": 0.7 }, gate: ["house-rules"] };
const judges = { strong: { provider: "codex-subscription", model: "gpt-strong", effort: "medium" } };

it("lowers a questionnaire check with its bank sidecar and bound JSON context, and judges and the critic into the train training block", async () => {
  const { loaded, out, plan } = await verifierProject({ judges, critic: { judge: "strong", guide: ["docs/WRITING.md"], show: ["train-tasks"] } }, [questionnaireExample]);
  expect(plan()).toMatchObject({ judges, critic: { judge: "strong", guide: [path.join(loaded.root, "docs/WRITING.md")], show: ["train-tasks"], block_on: "high" } });
  const datasets = await lowerTrainingMoments({ project: loaded, plan: plan(), out });
  const train = JSON.parse(await readFile(datasets.train, "utf8"));
  const [record] = train.records;
  expect(record.context).toEqual({ evidence: [{ source: "a" }] });
  const check = record.stages[0].checks[1];
  expect(check).toEqual({ id: "house-rules", eval: "questionnaire", bank: expect.stringMatching(/^sidecars\/[0-9a-f]{16}\/questions\.yaml$/u), input: "artifact:output", context: { evidence: "context:evidence" } });
  expect(await readFile(path.join(path.dirname(datasets.train), check.bank), "utf8")).toBe("bank bytes\n");
  expect(record.stages[0]).toMatchObject({ score: { linear: { grade: 0.3, "house-rules": 0.7 } }, gate: { all: [{ passed: "house-rules" }] } });
  expect(train.training).toEqual({ models: { strong: { provider: "codex-subscription", model: "gpt-strong", reasoning_effort: "medium" } },
    judges: { strong: { model: "strong" } }, critic: { judge: "strong", guide: [expect.stringMatching(/^sidecars\/[0-9a-f]{16}\/WRITING\.md$/u)], show: ["train-tasks"], block_on: "high" } });
  expect(await readFile(path.join(path.dirname(datasets.train), train.training.critic.guide[0]), "utf8")).toBe("Length follows the facts.\n");
  expect(JSON.parse(await readFile(datasets.test, "utf8")).training).toBeUndefined();
});

it("keeps the optimizer beside declared judges, binds no context a questionnaire does not name and adds no block without either", async () => {
  const bare = { ...questionnaireExample, checks: [{ id: "house-rules", eval: "questionnaire", bank: "../grading/questions.yaml" }] };
  const both = await verifierProject({ optimizer: { ...training.optimizer, provider: "codex-subscription" }, judges: { strong: { provider: "p", model: "m" } } }, [bare]);
  const train = JSON.parse(await readFile((await lowerTrainingMoments({ project: both.loaded, plan: both.plan(), out: both.out })).train, "utf8"));
  expect(train.training).toMatchObject({ models: { optimizer: { provider: "codex-subscription" }, strong: { provider: "p", model: "m" } }, judges: { strong: { model: "strong" } }, optimizer: { model: "optimizer" } });
  expect(train.training).not.toHaveProperty("critic");
  expect(train.records[0].stages[0].checks[1]).not.toHaveProperty("context");
  const none = await verifierProject({}, [bare]);
  expect(JSON.parse(await readFile((await lowerTrainingMoments({ project: none.loaded, plan: none.plan(), out: none.out })).train, "utf8")).training).toBeUndefined();
});

it("refuses a critic naming an undeclared judge, a judge named optimizer and a JSON context that does not parse", async () => {
  expect((await verifierProject({ critic: { judge: "strong", guide: ["docs/WRITING.md"] } }, [questionnaireExample])).plan).toThrow(/undeclared judge strong/u);
  const reserved = await verifierProject({ judges: { optimizer: { provider: "p", model: "m" } } }, [questionnaireExample]);
  await expect(lowerTrainingMoments({ project: reserved.loaded, plan: reserved.plan(), out: reserved.out })).rejects.toThrow(/reserved/u);
  const broken = await verifierProject({ judges }, [{ ...questionnaireExample, context: { evidence: { file: "../grading/broken.json", json: true } } }]);
  await expect(lowerTrainingMoments({ project: broken.loaded, plan: broken.plan(), out: broken.out })).rejects.toThrow(/context evidence is not JSON/u);
});
