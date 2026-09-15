import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { TrainingContext } from "../contract.js";
import type { TrainingImagePlan } from "../preparation/image.js";
import type { PlannedInput } from "../preparation/inputs.js";
import { assertInputRoot, copySealed, exactPath, hashJson, sealFile, sealTree, within } from "../preparation/files.js";
import { readTrainingWitness } from "./witness.js";
import { verifyTrainingCompatibility } from "./compatibility.js";
import { repairEnvelopeSchema } from "./contract.js";

const commandSchema = z.object({ schema: z.literal("paideia.command-checkpoint.v1"), id: z.string().uuid(), identity: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
export async function planMeasurementRepair(options: { parent: string; witness?: string; output: string;
  auth: string[]; image: TrainingImagePlan; inputs: PlannedInput[]; context: TrainingContext; resume: boolean }) {
  const parent = await exactPath(options.parent);
  assertInputRoot(parent, options.auth);
  if (within(parent, options.output) || within(options.output, parent)) throw Error("Repair output must be disjoint from parent");
  if (!options.resume) {
    try { await lstat(options.output); throw Error("Measurement repair requires a fresh output directory"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const staging = path.join(path.dirname(parent), `.spawnfile-training-preparation-${hashJson(parent).slice(7, 23)}`);
  const witness = await readTrainingWitness(options.witness ?? path.join(staging, "witness/manifest.json"));
  const state = JSON.parse(await readFile(path.join(staging, "state.json"), "utf8")) as { digest: string; image: string };
  if (state.digest !== witness.manifest.parentPreparationDigest || state.image !== witness.manifest.parentImage) throw Error("Repair parent preparation does not match witness");
  const compatibility = verifyTrainingCompatibility(witness.manifest, options.image, options.inputs, options.context);
  compatibility.components["parent-witness"] = witness.digest;
  const files = [...await sealTree(path.join(parent, "runs"), "runs"), ...await sealTree(path.join(parent, "blobs"), "blobs")];
  const checkpoints: Record<string, string> = {};
  for (const name of ["command", "training", "host", "optimizer"]) {
    const file = await sealFile(path.join(parent, "checkpoint", `${name}.json`), `checkpoint/${name}.json`);
    files.push(file); checkpoints[name] = file.sha256;
  }
  const command = commandSchema.parse(JSON.parse(await readFile(path.join(parent, "checkpoint/command.json"), "utf8")));
  const training = JSON.parse(await readFile(path.join(parent, "checkpoint/training.json"), "utf8")) as { state?: { identity?: unknown } };
  const trainingIdentity = z.string().regex(/^[a-f0-9]{64}$/u).parse(training.state?.identity);
  const manifest = { version: "paideia.repair-parent.v1", files: files.map(file => ({ path: file.destination, sha256: file.sha256, size: file.size })) };
  return { parent, witness, compatibility, files, command, trainingIdentity, checkpoints,
    manifest, manifestDigest: hashJson(manifest) };
}
export type MeasurementRepairPlan = Awaited<ReturnType<typeof planMeasurementRepair>>;

export async function stageMeasurementRepair(plan: MeasurementRepairPlan, staging: string, image: string,
  canonicalSourceDigest: string, resume: boolean) {
  const root = path.join(staging, "repair-parent"), repairPath = path.join(staging, "repair.json");
  const compatibility = { version: "spawnfile.daimon-dspy-compatibility.v1", ...plan.compatibility,
    digest: hashJson(plan.compatibility) };
  const receipt = repairEnvelopeSchema.shape.receipt.parse({ version: "paideia.measurement-repair.v1",
    parent: { root: "/run/training/inputs/repair-parent", imageId: plan.witness.manifest.parentImage,
      experimentId: plan.command.id, executionIdentity: plan.command.identity, manifestDigest: plan.manifestDigest,
      checkpoints: plan.checkpoints, trainingIdentity: plan.trainingIdentity },
    current: { imageId: image, canonicalSourceDigest, adapterId: "daimon-native" }, compatibility });
  const envelope = { receipt, digest: hashJson(receipt) };
  if (resume) {
    if (await exactPath(repairPath) !== repairPath || hashJson(JSON.parse(await readFile(repairPath, "utf8"))) !== hashJson(envelope)) throw Error("Saved measurement repair receipt changed");
    if ((await sealFile(path.join(root, "projection-manifest.json"), "manifest")).sha256 !== plan.manifestDigest) throw Error("Saved repair projection changed");
    for (const file of plan.files) if ((await sealFile(path.join(root, file.destination), file.destination)).sha256 !== file.sha256) throw Error("Saved repair capture changed");
  } else {
    await mkdir(root, { mode: 0o700 });
    await copySealed(plan.files, root);
    await writeFile(path.join(root, "projection-manifest.json"), JSON.stringify(plan.manifest), { mode: 0o400, flag: "wx" });
    await writeFile(repairPath, JSON.stringify(envelope), { mode: 0o400, flag: "wx" });
  }
  return { repairPath, root };
}
