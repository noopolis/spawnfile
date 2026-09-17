import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TrainingContext } from "../contract.js";
import type { TrainingPreparationConfig } from "../preparation/contract.js";
import type { TrainingImagePlan } from "../preparation/image.js";
import { copySealed, exactPath, fileIdentity, hashJson, sealTree } from "../preparation/files.js";
import type { PlannedInput } from "../preparation/inputs.js";
import { witnessEnvelopeSchema, type TrainingWitness } from "./contract.js";

export async function readTrainingWitness(file: string) {
  const canonical = await exactPath(file), bytes = await readFile(canonical, "utf8");
  if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) throw Error("Training witness exceeds 8 MiB");
  const raw = JSON.parse(bytes) as { manifest: unknown; digest: string };
  if (hashJson(raw.manifest) !== raw.digest) throw Error("Training witness digest mismatch");
  const parsed = witnessEnvelopeSchema.parse(raw), witness = parsed.manifest;
  const files = await sealTree(path.join(path.dirname(canonical), "image-files"), "");
  const sorted = (value: ReturnType<typeof fileIdentity>) => [...value].sort((a, b) => a.destination.localeCompare(b.destination));
  if (hashJson(sorted(fileIdentity(files))) !== hashJson(sorted(witness.image.files))) throw Error("Training witness image bytes changed");
  const { recipe, nativeImage, pythonImage, platform } = witness.image.build;
  if (hashJson({ recipe, nativeImage, pythonImage, platform, files: witness.image.files,
    dockerfile: witness.image.dockerfile, entry: witness.image.entry, brokerEntry: witness.image.brokerEntry }) !== witness.imagePlanDigest) throw Error("Training witness recipe identity mismatch");
  const expected = hashJson({ config: raw.manifest && (raw.manifest as TrainingWitness).config,
    sources: witness.inputs.map(input => ({ id: input.id, digest: input.digest })),
    image: witness.imagePlanDigest, canonical: witness.context.project.sourceDigest, ...(witness.repair ? { repair: witness.repair } : {}) });
  if (expected !== witness.parentPreparationDigest) throw Error("Training witness preparation identity mismatch");
  return { ...parsed, path: canonical };
}

/** Future repairs need sealed original bytes, not a mutable checkout or caller assertion. */
export async function writeTrainingWitness(options: { directory: string; digest: string; image: string;
  config: TrainingPreparationConfig; context: TrainingContext; args: readonly string[];
  inputs: PlannedInput[]; staged: string[]; snapshots: (string | null)[]; plan: TrainingImagePlan; repair?: { witness: string; parent: string } }) {
  const directory = path.join(options.directory, "witness");
  await mkdir(directory, { mode: 0o700 });
  await copySealed(options.plan.files, path.join(directory, "image-files"));
  const manifest: TrainingWitness = { schema: "spawnfile.training-witness.v1", parentImage: options.image,
    parentPreparationDigest: options.digest, imagePlanDigest: options.plan.digest, config: options.config,
    ...(options.repair ? { repair: options.repair } : {}),
    context: options.context, command: { args: [...options.args] },
    inputs: options.inputs.map((input, index) => ({ id: input.id, source: input.source, destination: input.destination,
      digest: input.digest, staged: options.staged[index]!, snapshotDigest: options.snapshots[index]! })),
    image: { build: options.plan.build, files: fileIdentity(options.plan.files), dockerfile: options.plan.dockerfile,
      entry: options.plan.entry, brokerEntry: options.plan.brokerEntry } };
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ manifest, digest: hashJson(manifest) }), { flag: "wx", mode: 0o400 });
}
