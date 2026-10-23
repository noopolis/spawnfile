import { execFile } from "node:child_process";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createTrainingContext } from "../context.js";
import { trainingExecutionSchema } from "../execution.js";
import { prepareTraining } from "../preparation/prepare.js";
import { preparationFixture, imageDocker, sha } from "../preparation/fixtures.test-helper.js";
import { hashJson } from "../preparation/files.js";
import { readTrainingWitness } from "./witness.js";
import type { TrainingWitness } from "./contract.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it.each([
  { brokered: false, authored: true }, { brokered: true, authored: true },
  { brokered: false, authored: false }, { brokered: true, authored: false }
])("round-trips a real build preparation witness (brokered: $brokered, authored: $authored)", async ({ brokered, authored }) => {
  const f = await preparationFixture(); roots.push(f.root);
  await f.put("project/Spawnfile", `spawnfile_version: "0.1"
kind: agent
name: author
runtime:
  name: daimon
  options:
    engine: codex
    codex_policy: workspace-no-network
execution:
  sandbox:
    mode: workspace
`);
  const context = await createTrainingContext(f.context.project.manifest, { packageVersion: "test" });
  const git = (args: string[]) => promisify(execFile)("git", args, { cwd: context.project.root });
  await git(["init", "-q"]); await git(["add", "."]);
  await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "seed"]);
  await f.put("overlay", "generated");
  f.config.inputs[0]!.git = { revision: (await git(["rev-parse", "HEAD"])).stdout.trim(),
    overlays: [{ source: "overlay", path: "tools.txt", sha256: sha("generated") }] };
  f.config.inputs[1]!.include = ["settings.json"];
  f.config.auth[0]!.provider = "codex";
  f.config.evaluatorRoutes = [{ purpose: "decisions", provider: "typesafe", model: "judge", maxRequests: 20, maxSpendUsd: 1 }];
  f.config.evaluatorSecrets = [{ provider: "typesafe", source: "typesafe-key" }];
  await f.put("typesafe-key", "fake-evaluator-secret");
  if (brokered) {
    f.config.version = "spawnfile.training-container.v4";
    f.config.broker = { engine: "grok", maxRunRequests: 50, agentId: "agent:a", model: "grok-4.6", reasoningEffort: "low",
      architecture: "arm64", limits: { maxRequests: 4, maxTokens: 100, timeoutMs: 1000 }, realmVolume: "realm", bootstrap: "broker-auth" };
    await f.put("broker-auth", "fake-broker-auth"); await chmod(path.join(f.root, "broker-auth"), 0o600);
  } else f.config.subjectIsolation = "codex-native-sandbox";
  // Exercise the defaulted slots and the effective absolute output override used by authored training.
  const { slots: _slots, ...declaration } = f.config;
  await writeFile(f.configPath, JSON.stringify(declaration));
  const optimizer = { method: "gepa", model: "same-model", variants: 4, keep: 2, budget: { rounds: 3 } };
  const execution = authored ? trainingExecutionSchema.parse({ version: "spawnfile.training-execution.v1",
    optimizer, args: f.args, output: path.join(f.root, "output"), datasetPins: [{ sourcePath: f.args[1], sha256: sha("fixture") }],
    authoring: { version: "spawnfile.training-plan.v1", producer: { package: "spawnfile", version: "test" },
      project: { root: context.project.root, manifest: context.project.manifest },
      agent: { id: context.agent.id, name: context.agent.name }, optimizer, record: null, graders: [], targets: [] } }) : undefined;
  const docker = imageDocker();
  const prepared = await prepareTraining({ configPath: f.configPath, context, args: f.args, execution,
    outputOverride: path.join(f.root, "output"), dryRun: false, process: docker.process, timeoutMs: 30000,
    packageRoot: path.join(f.root, "own"), streams: { stdout() {}, stderr() {} } });
  if ("dryRun" in prepared) throw Error("actual preparation expected");
  const file = path.join(path.dirname(prepared.preparationPath), "witness/manifest.json");
  const bytes = await readFile(file, "utf8");
  const witness = await readTrainingWitness(file).catch((error: unknown) => error);
  expect(witness, "preparation witness round-trip guarantee").toMatchObject({ manifest: { parentPreparationDigest: prepared.digest } });
  expect(docker.calls.some(call => call[2] === "build")).toBe(true);
  expect(bytes).not.toContain("fake-evaluator-secret");
  if (!execution) return;
  await chmod(file, 0o600);
  const rewrite = async (change: (manifest: TrainingWitness) => void) => {
    const envelope = JSON.parse(bytes); change(envelope.manifest);
    envelope.digest = hashJson(envelope.manifest); await writeFile(file, JSON.stringify(envelope));
  };
  // The identity uses normalized argv but still binds optimizer controls and every other execution field.
  await rewrite(manifest => { manifest.execution!.args = ["--resume", "--out", execution.output, "--train", f.args[1]!]; });
  await expect(readTrainingWitness(file)).resolves.toMatchObject({ manifest: { parentPreparationDigest: prepared.digest } });
  for (const change of [
    (manifest: TrainingWitness) => { delete manifest.execution; },
    (manifest: TrainingWitness) => { manifest.execution!.optimizer.keep = 1; },
    (manifest: TrainingWitness) => { manifest.execution!.datasetPins[0]!.sha256 = sha("changed"); },
    (manifest: TrainingWitness) => { manifest.config.evaluatorRoutes![0]!.maxRequests++; }
  ]) {
    await rewrite(change);
    await expect(readTrainingWitness(file), "witness execution identity guarantee").rejects.toThrow("preparation identity mismatch");
  }
});


it("validates a null witness manifest without throwing a property access error", async () => {
  const f = await preparationFixture(); roots.push(f.root);
  const file = path.join(f.root, "null-witness.json");
  await writeFile(file, JSON.stringify({ manifest: null, digest: hashJson(null) }));
  const error = await readTrainingWitness(file).then(() => undefined, error => error);
  expect(error).toMatchObject({ name: "ZodError" });
});


it.each([
  { image: { build: 1, files: [] } },
  { image: { build: "install", files: [] } },
  { image: { build: null, files: [] } },
  { image: { build: {}, files: {} } },
  { image: { build: {}, files: "files" } },
  { image: { build: {}, files: [null] } },
  { image: { build: {}, files: [{ destination: 1 }] } },
  { image: null },
  1,
  "manifest"
])("routes malformed witness shape through schema validation: %j", async manifest => {
  const f = await preparationFixture(); roots.push(f.root);
  const file = path.join(f.root, "malformed-witness.json");
  await writeFile(file, JSON.stringify({ manifest, digest: hashJson(manifest) }));
  const error = await readTrainingWitness(file).then(() => undefined, error => error);
  expect(error, "malformed witness schema guarantee").toMatchObject({ name: "ZodError" });
});

it.each([null, 1, "envelope", [], { manifest: null, digest: 1 }])(
  "validates malformed witness envelopes before migration inspection: %j", async envelope => {
    const f = await preparationFixture(); roots.push(f.root);
    const file = path.join(f.root, "malformed-envelope.json");
    await writeFile(file, JSON.stringify(envelope));
    const error = await readTrainingWitness(file).then(() => undefined, error => error);
    expect(error, "malformed envelope schema guarantee").toMatchObject({ name: "ZodError" });
  });
