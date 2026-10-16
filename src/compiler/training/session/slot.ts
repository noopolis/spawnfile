import { randomBytes } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { DAIMON_GROK_ENGINE_BROKER } from "../../../runtime/daimon/contractManifest.js";
import { parseTrainingBrokerDeclaration } from "../broker/declaration.js";
import { TRAINING_BROKER_DECLARATION_FILE, trainingSlotDescriptors, trainingSlotsDocument, type TrainingSlotsDocument } from "../broker/paths.js";
import { loadDaimonProjectionModule, resolveTrainingGrokProjection } from "../broker/projection.js";
import { resolveTrainingGrokRegistration } from "../broker/registration.js";
import { recycleTrainingSessionSlot } from "./recycle.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const preflightSchema = z.object({
  version: z.literal(DAIMON_GROK_ENGINE_BROKER.slotPreflightVersion), slot: z.number().int(), worker_uid: z.number().int(),
  generation: z.number().int().positive(), nonce: digest, projection_sha256: digest,
  sandbox_profile_sha256: digest, seccomp_profile_sha256: digest, grok_executable_sha256: digest,
  sandbox_runtime: z.literal("bubblewrap"),
  canaries: z.array(z.object({ path: z.string(), method: z.literal("sandboxed-read"), result: z.literal("denied") }).strict()).min(1),
  created_at: z.string().datetime()
}).strict();
const readPrivateJson = async (file: string): Promise<unknown> => {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536 || stat.mode & 0o022 || await realpath(file) !== file) {
    throw Error("Training session metadata must be a bounded canonical non-writable file");
  }
  return JSON.parse(await readFile(file, "utf8"));
};
export interface PrepareTrainingSessionSlotOptions {
  slot: TrainingSlotsDocument["slots"][number]; slots: number; signal: AbortSignal;
  expectedNonce?: string; minGeneration?: number;
}
export interface TrainingSessionSlotDependencies {
  read?: (file: string) => Promise<unknown>;
  recycle?: typeof recycleTrainingSessionSlot;
  projection?: typeof resolveTrainingGrokProjection;
  loadRuntime?: typeof loadDaimonProjectionModule;
}

/** Shared authority, immutable descriptor, fresh reset and matching native projection. */
export const prepareTrainingSessionSlot = async (options: PrepareTrainingSessionSlotOptions,
  dependencies: TrainingSessionSlotDependencies = {}) => {
  const { slot, slots, signal } = options;
  signal.throwIfAborted();
  const expected = trainingSlotsDocument(slots).slots.find(row => row.index === slot.index);
  if (!expected || !isDeepStrictEqual(slot, expected)) throw Error("Training session lease differs from the provisioned slot");
  const read = dependencies.read ?? readPrivateJson;
  const declaration = parseTrainingBrokerDeclaration(await read(TRAINING_BROKER_DECLARATION_FILE));
  if (declaration.slots !== slots) throw Error("Training session slot count differs from the shared broker");
  const nonce = options.expectedNonce ?? randomBytes(32).toString("hex"), minGeneration = options.minGeneration ?? 1;
  if (!/^[a-f0-9]{64}$/u.test(nonce) || !Number.isSafeInteger(minGeneration) || minGeneration < 1) throw Error("Invalid slot freshness request");
  const p = trainingSlotDescriptors(slots)[slot.index]!;
  const reset = await (dependencies.recycle ?? recycleTrainingSessionSlot)(slot.index, nonce, signal);
  if (reset.slot !== slot.index || reset.nonce !== nonce || reset.receipt !== p.preflightReceipt || reset.generation < minGeneration) {
    throw Error("Training session reset does not bind this lease freshness");
  }
  signal.throwIfAborted();
  const registration = resolveTrainingGrokRegistration({ ...declaration, slot: slot.index, slots });
  const projection = await (dependencies.projection ?? resolveTrainingGrokProjection)(declaration, registration,
    await (dependencies.loadRuntime ?? loadDaimonProjectionModule)());
  const receipt = preflightSchema.parse(await read(p.preflightReceipt));
  const executable = DAIMON_GROK_ENGINE_BROKER.grokCliArtifacts[declaration.architecture].sha256;
  if (receipt.slot !== slot.index || receipt.worker_uid !== slot.workerUid || receipt.nonce !== nonce || receipt.generation !== reset.generation ||
    receipt.projection_sha256 !== projection.projectionSha256 || receipt.sandbox_profile_sha256 !== registration.profileSha256 ||
    receipt.seccomp_profile_sha256 !== declaration.seccompProfileSha256 || receipt.grok_executable_sha256 !== executable ||
    !isDeepStrictEqual(receipt.canaries.map(row => row.path).sort(), [...registration.denyPaths].sort())) {
    throw Error("Training session preflight evidence differs from the reset projection");
  }
  signal.throwIfAborted();
  return { slot, declaration, generation: reset.generation, nonce, receipt: reset.receipt, ports: p.ports,
    broker: { projectionVersion: String(projection.projection.version), workerConfigVariant: "clocked" as const,
      projectionSha256: projection.projectionSha256, slot: slot.index, workerUid: slot.workerUid,
      workerHomePath: p.workerHome, architecture: declaration.architecture, usageLedgerPath: p.usageLedger,
      seccompProfileSha256: declaration.seccompProfileSha256, profileSha256: registration.profileSha256,
      denyPaths: [...registration.denyPaths], limits: { ...declaration.limits }, evaluatorPaths: p.evaluatorPaths,
      slotPreflightReceipt: p.preflightReceipt, expectedNonce: nonce, minGeneration } };
};
export type PreparedTrainingSessionSlot = Awaited<ReturnType<typeof prepareTrainingSessionSlot>>;
