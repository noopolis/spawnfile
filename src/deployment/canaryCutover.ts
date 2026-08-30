import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { link, open, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";
import { SpawnfileError } from "../shared/index.js";
import { parseUpReceipt, type UpReceipt } from "./upReceiptTypes.js";
import { parseDownReceipt } from "./downReceiptTypes.js";

const execFile = promisify(execFileCallback);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u), runId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u), nonce = z.string().regex(/^[a-f0-9]{32}$/u);
const ingressReceiptSchema = z.object({ version: z.literal("spawnfile.ingress-cutover-receipt.v1"), state: z.literal("switched"), nonce, from_deployment: z.string().min(1), to_deployment: z.string().min(1), target_run_id: runId, readiness_sha256: digest }).strict();
const decisionReceiptSchema = z.object({ version: z.literal("spawnfile.canary-decision-receipt.v1"), decision: z.literal("cutover"), nonce, target_run_id: runId, deployment_mode: z.enum(["project", "image"]), target_identity_sha256: digest, ingress_receipt_sha256: digest, teardown_checkpoint_sha256: digest, down_receipt_sha256: digest }).strict();
const reportSchema = z.object({
  persistent_mounts: z.array(z.object({
    id: z.string().min(1),
    lifecycle: z.literal("exclusive-reattach").optional()
  }).passthrough()).max(4096).optional().default([]),
  published_ports: z.array(z.number().int().min(1).max(65535)).max(64)
}).passthrough();
export const deploymentIdentitySchema = z.object({ version: z.literal("spawnfile.deployment-identity.v1"), run_id: runId, fingerprint: z.string().min(1), deployment_name: z.string().min(1), deployment_mode: z.enum(["project", "image"]), image_id: z.string().regex(/^sha256:[a-f0-9]{64}$/u), organization_unit_id: z.string().min(1), organization_compile_fingerprint: z.string().min(1), organization_world_binding_digest: digest.nullable(), topology_sha256: digest }).strict();
type Execute = (command: string, args: string[]) => Promise<string | void>;
const execute: Execute = async (command, args) => (await execFile(command, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 1_048_576 })).stdout;
type Inspect = (command: string, args: string[]) => Promise<string>;
const inspect: Inspect = async (command, args) => (await execFile(command, args, { encoding: "utf8", timeout: 10_000, maxBuffer: 1_048_576 })).stdout;
const sha = (bytes: Buffer | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
const topologyDigest = (receipt: UpReceipt): string => sha(canonical({ compiled_schedule: receipt.compiled_schedule, engines: receipt.engines ?? [], moltnet_release: receipt.moltnet_release ?? null }));

export const verifyCandidatePortIsolation = (liveReport: unknown, candidateReport: unknown): number[] => {
  const liveReportValue = reportSchema.parse(liveReport), candidateReportValue = reportSchema.parse(candidateReport);
  const live = new Set(liveReportValue.published_ports), candidate = candidateReportValue.published_ports;
  if (candidate.some((port) => live.has(port)) || new Set(candidate).size !== candidate.length) throw new SpawnfileError("validation_error", "Candidate published ports are not mechanically isolated from live");
  const liveMounts = new Map(liveReportValue.persistent_mounts.map((mount) => [mount.id, mount]));
  const sharedExclusive = candidateReportValue.persistent_mounts.find((mount) =>
    liveMounts.has(mount.id)
    && (mount.lifecycle === "exclusive-reattach" || liveMounts.get(mount.id)?.lifecycle === "exclusive-reattach")
  );
  if (sharedExclusive) throw new SpawnfileError(
    "validation_error",
    `Candidate shares exclusive persistent mount ${sharedExclusive.id}; use stop-and-reattach deployment instead of concurrent canary`
  );
  return candidate;
};
const verifyIdentity = (receipt: UpReceipt, expected: z.infer<typeof deploymentIdentitySchema>): void => {
  const ready = receipt.organization_ready;
  if (receipt.run_id !== expected.run_id || receipt.fingerprint !== expected.fingerprint || receipt.deployment.name !== expected.deployment_name || ready?.state !== "ready" || ready.unit_id !== expected.organization_unit_id || ready.compile_fingerprint !== expected.organization_compile_fingerprint || ready.world_binding_digest !== expected.organization_world_binding_digest || topologyDigest(receipt) !== expected.topology_sha256) throw new SpawnfileError("validation_error", "Readiness does not bind the exact intended deployment identity and topology");
};
export const issueDeploymentIdentity = async (readinessPath: string, deploymentMode: "project" | "image", dockerCommand: string, imageInspect: Inspect = inspect): Promise<Record<string, unknown>> => {
  const receipt = parseUpReceipt(JSON.parse(await readFile(readinessPath, "utf8"))), ready = receipt.organization_ready;
  if (receipt.run_id === null || receipt.deployment.name === null || receipt.deployment.container_ids.length < 1 || ready?.state !== "ready") throw new SpawnfileError("validation_error", "Deployment is not identity-ready");
  const images = await Promise.all(receipt.deployment.container_ids.map(async (container) => (await imageInspect(dockerCommand, ["inspect", "--format", "{{.Image}}", container])).trim()));
  if (!images[0] || images.some((image) => image !== images[0])) throw new SpawnfileError("validation_error", "Deployment containers do not share one exact image identity");
  return deploymentIdentitySchema.parse({ version: "spawnfile.deployment-identity.v1", run_id: receipt.run_id, fingerprint: receipt.fingerprint, deployment_name: receipt.deployment.name, deployment_mode: deploymentMode, image_id: images[0], organization_unit_id: ready.unit_id, organization_compile_fingerprint: ready.compile_fingerprint, organization_world_binding_digest: ready.world_binding_digest, topology_sha256: topologyDigest(receipt) });
};
const syncParent = async (filePath: string): Promise<void> => { const directory = await open(path.dirname(filePath), "r"); try { await directory.sync(); } finally { await directory.close(); } };
const publishExclusive = async (filePath: string, value: unknown): Promise<void> => { const temporary = `${filePath}.tmp-${process.pid}`; const file = await open(temporary, "wx", 0o600); try { await file.writeFile(`${JSON.stringify(value)}\n`); await file.sync(); } finally { await file.close(); } try { await link(temporary, filePath); await syncParent(filePath); } finally { await rm(temporary, { force: true }); await syncParent(filePath); } };
const exists = async (filePath: string): Promise<boolean> => await readFile(filePath).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error));

export const runCanaryCutover = async (input: { liveReportPath: string; candidateReportPath: string; readinessPath: string; expectedIdentity: unknown; dockerCommand: string; nonce: string; transactionPath: string; ingressCommand: string; ingressArgs: string[]; ingressReceiptPath: string; teardownCommand: string; teardownArgs: string[]; teardownPolicy: "export" | "force"; teardownProjectPath: string; teardownCompiledPath: string; decisionReceiptPath: string; fromDeployment: string; toDeployment: string }, runner: Execute = execute, imageInspect: Inspect = inspect): Promise<Record<string, unknown>> => {
  const expected = deploymentIdentitySchema.parse(input.expectedIdentity), operationNonce = nonce.parse(input.nonce);
  if (input.ingressArgs.length > 32 || input.teardownArgs.length > 32 || [...input.ingressArgs, ...input.teardownArgs].some((arg) => arg.length > 4096)) throw new SpawnfileError("validation_error", "Canary command arguments exceed bounds");
  const lifecycleId = `lci_canary_${operationNonce}`, exportIndex = input.teardownArgs.indexOf("--export-to"), prefix = ["down", input.teardownProjectPath, "--compiled", input.teardownCompiledPath, "--deployment", input.fromDeployment], expectedTeardownArgs = input.teardownPolicy === "export" ? [...prefix, "--export-to", input.teardownArgs[exportIndex + 1] ?? "", "--json", "--lifecycle-invocation", lifecycleId] : [...prefix, "--force", "--json", "--lifecycle-invocation", lifecycleId];
  const canonicalPath = (value: string): boolean => path.isAbsolute(value) && path.resolve(value) === value && path.normalize(value) === value;
  if (!canonicalPath(input.teardownProjectPath) || !canonicalPath(input.teardownCompiledPath) || path.basename(input.teardownCommand) !== "spawnfile" || (input.teardownPolicy === "export" && (exportIndex < 0 || !expectedTeardownArgs[7])) || canonical(input.teardownArgs) !== canonical(expectedTeardownArgs)) throw new SpawnfileError("validation_error", "Teardown is not the exact canonical Spawnfile lifecycle down operation");
  verifyCandidatePortIsolation(JSON.parse(await readFile(input.liveReportPath, "utf8")), JSON.parse(await readFile(input.candidateReportPath, "utf8")));
  const readinessBytes = await readFile(input.readinessPath), readiness = parseUpReceipt(JSON.parse(readinessBytes.toString("utf8"))); verifyIdentity(readiness, expected);
  if (readiness.deployment.container_ids.length < 1) throw new SpawnfileError("validation_error", "Ready deployment has no image-bearing containers");
  for (const container of readiness.deployment.container_ids) if ((await imageInspect(input.dockerCommand, ["inspect", "--format", "{{.Image}}", container])).trim() !== expected.image_id) throw new SpawnfileError("validation_error", "Ready deployment image does not match intended identity");
  const binding = sha(canonical({ ...input, expectedIdentity: expected }));
  const transaction = { version: "spawnfile.canary-transaction.v1", state: "reserved", nonce: operationNonce, binding_sha256: binding };
  const recovering = await exists(input.transactionPath);
  if (recovering) { const prior = JSON.parse(await readFile(input.transactionPath, "utf8")); if (prior.version !== transaction.version || prior.nonce !== operationNonce || prior.binding_sha256 !== binding) throw new SpawnfileError("validation_error", "Canary transaction authority does not match"); }
  else { if (await exists(input.ingressReceiptPath) || await exists(input.decisionReceiptPath)) throw new SpawnfileError("validation_error", "Stale canary receipt exists before transaction reservation"); await publishExclusive(input.transactionPath, transaction); }
  if (!await exists(input.ingressReceiptPath)) await runner(input.ingressCommand, input.ingressArgs);
  const ingressBytes = await readFile(input.ingressReceiptPath), ingress = ingressReceiptSchema.parse(JSON.parse(ingressBytes.toString("utf8")));
  if (ingress.nonce !== operationNonce || ingress.from_deployment !== input.fromDeployment || ingress.to_deployment !== input.toDeployment || ingress.target_run_id !== expected.run_id || ingress.readiness_sha256 !== sha(readinessBytes)) throw new SpawnfileError("validation_error", "Ingress receipt does not bind the exact ready target and transaction nonce");
  const teardownStartedPath = `${input.transactionPath}.teardown-started`, teardownReceiptPath = `${input.transactionPath}.teardown-receipt`, teardownCheckpointPath = `${input.transactionPath}.teardown-complete`, checkpointBase = { nonce: operationNonce, binding_sha256: binding, ingress_receipt_sha256: sha(ingressBytes), lifecycle_invocation: lifecycleId };
  if (!await exists(teardownCheckpointPath)) {
    if (await exists(input.decisionReceiptPath)) throw new SpawnfileError("validation_error", "Canary decision exists without its teardown checkpoint");
    if (!await exists(teardownStartedPath)) await publishExclusive(teardownStartedPath, { version: "spawnfile.canary-teardown-started.v1", ...checkpointBase });
    if (!await exists(teardownReceiptPath)) { const output = await runner(input.teardownCommand, input.teardownArgs), down = parseDownReceipt(JSON.parse(typeof output === "string" ? output : "")); if (down.deployment !== input.fromDeployment || down.errors.length !== 0) throw new SpawnfileError("validation_error", "Down receipt does not prove exact teardown completion"); await publishExclusive(teardownReceiptPath, down); }
    const downBytes = await readFile(teardownReceiptPath), down = parseDownReceipt(JSON.parse(downBytes.toString("utf8"))); if (down.deployment !== input.fromDeployment || down.errors.length !== 0) throw new SpawnfileError("validation_error", "Stored down receipt does not bind the teardown operation"); await publishExclusive(teardownCheckpointPath, { version: "spawnfile.canary-teardown-checkpoint.v1", ...checkpointBase, down_receipt_sha256: sha(downBytes) });
  }
  else { const downBytes = await readFile(teardownReceiptPath), down = parseDownReceipt(JSON.parse(downBytes.toString("utf8"))), expectedCheckpoint = { version: "spawnfile.canary-teardown-checkpoint.v1", ...checkpointBase, down_receipt_sha256: sha(downBytes) }; if (down.deployment !== input.fromDeployment || down.errors.length !== 0 || canonical(JSON.parse(await readFile(teardownCheckpointPath, "utf8"))) !== canonical(expectedCheckpoint)) throw new SpawnfileError("validation_error", "Canary teardown checkpoint does not match the recovered transaction"); }
  const checkpointBytes = await readFile(teardownCheckpointPath), downBytes = await readFile(teardownReceiptPath), decision = { version: "spawnfile.canary-decision-receipt.v1", decision: "cutover", nonce: operationNonce, target_run_id: expected.run_id, deployment_mode: expected.deployment_mode, target_identity_sha256: sha(canonical(expected)), ingress_receipt_sha256: sha(ingressBytes), teardown_checkpoint_sha256: sha(checkpointBytes), down_receipt_sha256: sha(downBytes) };
  if (!await exists(input.decisionReceiptPath)) { await publishExclusive(input.decisionReceiptPath, decision); return decision; }
  const priorDecision = decisionReceiptSchema.parse(JSON.parse(await readFile(input.decisionReceiptPath, "utf8"))); if (canonical(priorDecision) !== canonical(decision)) throw new SpawnfileError("validation_error", "Canary decision receipt does not match the recovered transaction"); return priorDecision;
};

export const verifyEquivalentRollbackReadiness = async (rollbackReadinessPath: string, expectedIdentity: unknown): Promise<void> => { const expected = deploymentIdentitySchema.parse(expectedIdentity), rollback = parseUpReceipt(JSON.parse(await readFile(rollbackReadinessPath, "utf8"))); verifyIdentity(rollback, expected); };
