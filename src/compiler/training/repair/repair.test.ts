import { chmod, mkdir, readFile, readdir, rm, writeFile, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { preparationFixture, imageDocker, image } from "../preparation/fixtures.test-helper.js";
import { prepareTraining } from "../preparation/prepare.js";
import { readTrainingWitness } from "./witness.js";
import { hashJson } from "../preparation/files.js";
import { repairEnvelopeSchema } from "./contract.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const f = await preparationFixture(); roots.push(f.root);
  await f.put("paideia/dist/src/adapters/daimon-native/adapter.js", "native");
  await f.put("paideia/dist/src/experiments/trials/trial.js", "subject");
  await f.put("bridge/paideia_dspy/checkpoint.py", "checkpoint-v1");
  await f.put("bridge/paideia_dspy/protocol.py", "wire-v1");
  await f.put("bridge/paideia_dspy/optimizer.py", "gepa");
  const docker = imageDocker();
  const options = { configPath: f.configPath, context: f.context, args: f.args, dryRun: false,
    process: docker.process, timeoutMs: 30000, packageRoot: path.join(f.root, "own"), streams: { stdout() {}, stderr() {} } };
  const previous = await prepareTraining(options); if ("dryRun" in previous) throw Error("actual");
  const parent = path.join(f.root, "output"), staging = path.dirname(previous.preparationPath);
  await f.put("output/checkpoint/command.json", JSON.stringify({ schema: "paideia.command-checkpoint.v1", id: "00000000-0000-4000-8000-000000000001", identity: "a".repeat(64) }));
  await f.put("output/checkpoint/training.json", JSON.stringify({ state: { identity: "b".repeat(64) } }));
  await f.put("output/checkpoint/host.json", "{}"); await f.put("output/checkpoint/optimizer.json", "{}");
  await f.put("output/runs/record/events.jsonl", "event\n"); await f.put("output/blobs/digest", "article");
  await f.put("output/trials/private-home/auth", "DO-NOT-COPY"); await f.put("output/protected-judge-cache/cache", "DO-NOT-COPY");
  f.config.output.source = "child"; await f.save();
  const witnessPath = path.join(staging, "witness/manifest.json"), witness = await readTrainingWitness(witnessPath);
  const process: typeof docker.process = async (args, opts) => args[2] === "image" && args[4] === image && args.at(-1)!.includes("Config.Labels")
    ? { code: 0, stdout: `${JSON.stringify(image)}\n${JSON.stringify(witness.manifest.imagePlanDigest)}`, stderr: "" }
    : docker.process(args, opts);
  return { ...f, options: { ...options, process, args: ["--train", f.args[1]!, "--out", path.join(f.root, "child")], repairMeasurements: parent },
    parent, staging, witnessPath, witness, docker };
}

it("seals future witness automatically and projects repair captures with exact identities and no native homes", async () => {
  const f = await fixture();
  // Only evaluator and checkpoint transport changes are compatible.
  await f.put("paideia/dist/src/cli/main.js", "fixed evaluator");
  await f.put("bridge/paideia_dspy/checkpoint.py", "fork-support");
  await f.put("bridge/paideia_dspy/protocol.py", "fork-wire");
  const parentBytes = await readFile(path.join(f.parent, "checkpoint/host.json"));
  const prepared = await prepareTraining(f.options); if ("dryRun" in prepared) throw Error("actual");
  const envelope = repairEnvelopeSchema.parse(JSON.parse(await readFile(prepared.repairPath!, "utf8")));
  expect(envelope.digest).toBe(hashJson(envelope.receipt));
  expect(envelope.receipt.parent.executionIdentity).toBe("a".repeat(64));
  expect(envelope.receipt.parent.trainingIdentity).toBe("b".repeat(64));
  expect(envelope.receipt.compatibility.components["parent-witness"]).toBe(f.witness.digest);
  const launch = JSON.parse(await readFile(prepared.configPath, "utf8"));
  const mounted = launch.inputs.find((input: { destination: string }) => input.destination.endsWith("repair-parent"));
  expect((await readdir(mounted.source)).sort()).toEqual(["blobs", "checkpoint", "projection-manifest.json", "runs"]);
  expect(await readdir(path.join(mounted.source, "checkpoint"))).toHaveLength(4);
  const manifest = JSON.parse(await readFile(path.join(mounted.source, "projection-manifest.json"), "utf8"));
  expect(hashJson(manifest)).toBe(envelope.receipt.parent.manifestDigest);
  expect(manifest.files).toHaveLength(6);
  expect(prepared.args.slice(-4)).toEqual(["--repair-measurements", "/run/training/inputs/repair-parent", "--repair-context", "/run/paideia/repair.json"]);
  expect(await readFile(path.join(f.parent, "checkpoint/host.json"))).toEqual(parentBytes);
  expect(await prepareTraining({ ...f.options, args: [...f.options.args, "--resume"] })).toMatchObject({ repairPath: prepared.repairPath });
  await writeFile(path.join(mounted.source, "blobs/digest"), "tamper");
  await expect(prepareTraining({ ...f.options, args: [...f.options.args, "--resume"] })).rejects.toThrow("capture changed");
});

it.each(["native", "trials", "compiler", "integration", "optimizer", "input", "source", "image", "settings"])("rejects changed %s before Docker or output writes", async kind => {
  const f = await fixture();
  const changes: Record<string, string> = { native: "paideia/dist/src/adapters/daimon-native/adapter.js", trials: "paideia/dist/src/experiments/trials/trial.js",
    compiler: "own/dist/cli/index.js", integration: "integration/entry.ts", optimizer: "bridge/paideia_dspy/optimizer.py", input: "project/train.yaml" };
  if (changes[kind]) await f.put(changes[kind], "changed");
  if (kind === "source") f.options.context = { ...f.context, project: { ...f.context.project, sourceDigest: `sha256:${"f".repeat(64)}` } };
  if (kind === "image" && "build" in f.config.image) { f.config.image.build.nativeImage = `sha256:${"f".repeat(64)}`; await f.save(); }
  if (kind === "settings") { f.config.integration.settings.path = "."; await f.save(); }
  const count = f.docker.calls.length;
  await expect(prepareTraining(f.options)).rejects.toThrow(/changed/u);
  expect(f.docker.calls).toHaveLength(count);
  await expect(readFile(path.join(f.root, "child/checkpoint/command.json"))).rejects.toThrow();
});

it("rejects tampered witness or sealed compiler bytes and unavailable parent image labels", async () => {
  const f = await fixture(), original = await readFile(f.witnessPath, "utf8");
  await chmod(f.witnessPath, 0o600);
  const raw = JSON.parse(original); raw.manifest.parentImage = `sha256:${"f".repeat(64)}`;
  await writeFile(f.witnessPath, JSON.stringify(raw));
  await expect(prepareTraining(f.options)).rejects.toThrow("witness digest");
  await writeFile(f.witnessPath, original);
  await f.put(path.relative(f.root, path.join(f.staging, "witness/image-files/spawnfile/dist/cli/index.js")), "corrupted");
  await expect(prepareTraining(f.options)).rejects.toThrow("image bytes changed");
  await f.put(path.relative(f.root, path.join(f.staging, "witness/image-files/spawnfile/dist/cli/index.js")));
  await expect(prepareTraining({ ...f.options, process: f.docker.process })).rejects.toThrow();
});

it("validates repair dry-run without Docker, auth reads, projection or output and requires fresh/disjoint output", async () => {
  const f = await fixture(); const before = await readdir(f.root), calls = f.docker.calls.length;
  f.config.auth[0]!.source = "missing-auth"; await f.save();
  expect(await prepareTraining({ ...f.options, dryRun: true })).toMatchObject({ dryRun: true });
  expect(f.docker.calls).toHaveLength(calls); expect(await readdir(f.root)).toEqual(before);
  await mkdir(path.join(f.root, "child"));
  await expect(prepareTraining({ ...f.options, dryRun: true })).rejects.toThrow("fresh output");
  await expect(prepareTraining({ ...f.options, repairMeasurements: path.join(f.root, "child") })).rejects.toThrow("disjoint");
});

it("rejects parent symlinks and changed preparation binding", async () => {
  const f = await fixture(); await symlink(path.join(f.root, "auth"), path.join(f.parent, "blobs/leak"));
  await expect(prepareTraining(f.options)).rejects.toThrow("symlinks");
  await rm(path.join(f.parent, "blobs/leak"));
  const state = JSON.parse(await readFile(path.join(f.staging, "state.json"), "utf8")); state.digest = `sha256:${"d".repeat(64)}`;
  await writeFile(path.join(f.staging, "state.json"), JSON.stringify(state));
  await expect(prepareTraining(f.options)).rejects.toThrow("does not match witness");
});

it("checks recipe/preparation identities independently of the witness envelope and rejects oversize", async () => {
  const f = await fixture(), original = await readFile(f.witnessPath, "utf8"); await chmod(f.witnessPath, 0o600);
  for (const field of ["imagePlanDigest", "parentPreparationDigest"]) {
    const envelope = JSON.parse(original); envelope.manifest[field] = `sha256:${"f".repeat(64)}`;
    envelope.digest = hashJson(envelope.manifest); await writeFile(f.witnessPath, JSON.stringify(envelope));
    await expect(readTrainingWitness(f.witnessPath)).rejects.toThrow(/recipe identity|preparation identity/u);
  }
  await writeFile(f.witnessPath, " ".repeat(8 * 1024 * 1024 + 1));
  await expect(readTrainingWitness(f.witnessPath)).rejects.toThrow("8 MiB");
});

it("records a valid future witness for a repaired child and accepts verified legacy schema", async () => {
  const f = await fixture();
  const envelope = JSON.parse(await readFile(f.witnessPath, "utf8")); envelope.manifest.schema = "spawnfile.training-legacy-witness.v1";
  envelope.digest = hashJson(envelope.manifest); await chmod(f.witnessPath, 0o600); await writeFile(f.witnessPath, JSON.stringify(envelope));
  const prepared = await prepareTraining({ ...f.options, repairWitness: f.witnessPath }); if ("dryRun" in prepared) throw Error("actual");
  const future = await readTrainingWitness(path.join(path.dirname(prepared.preparationPath), "witness/manifest.json"));
  expect(future.manifest.repair?.witness).toBe(envelope.digest);
  expect(future.manifest.parentPreparationDigest).toBe(prepared.digest);
});
