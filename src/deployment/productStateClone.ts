import { constants } from "node:fs";
import { chmod, copyFile, link, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";

import { SpawnfileError } from "../shared/index.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const relative = z.string().min(1).max(255).refine((value) => !path.isAbsolute(value) && !value.split(/[\\/]/u).includes(".."));
const proofSchema = z.object({ version: z.literal("spawnfile.product-state-quiescence.v1"), state: z.literal("quiesced"), source_run_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u), files: z.array(z.object({ path: relative, sha256: digest }).strict()).min(1).max(4096) }).strict();
const forbidden = /(?:^|[._/-])(?:auth|credential|token|secret|session|wake)(?:[._/-]|$)|\.(?:db|sqlite|sqlite3)(?:-|$)/iu;
const execFile = promisify(execFileCallback);
const authoritySchema = z.object({ version: z.literal("spawnfile.product-state-source-authority.v1"), source_run_id: z.string(), container_id: z.string().regex(/^[a-f0-9]{64}$/u), image_id: z.string().regex(/^sha256:[a-f0-9]{64}$/u), started_at: z.string().min(1), was_paused: z.boolean(), source: z.string().min(1), mount_path: z.string().min(1), volume_name: z.string().min(1), candidate_volume_name: z.string().min(1), candidate_resource_identity: digest }).strict();
type DockerExec = (command: string, args: string[]) => Promise<{ stdout: string }>;
const defaultDockerExec: DockerExec = async (command, args) => await execFile(command, args, { encoding: "utf8", maxBuffer: 1_048_576, timeout: 10_000 });
const inspectContainer = async (docker: DockerExec, command: string, container: string): Promise<Record<string, any>> => { const value = JSON.parse((await docker(command, ["inspect", container])).stdout); if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== "object") throw new SpawnfileError("validation_error", "Managed source container inspection failed"); return value[0]; };
const restoreRunningState = async (docker: DockerExec, command: string, authority: z.infer<typeof authoritySchema>): Promise<void> => {
  await docker(command, ["unpause", authority.container_id]);
  const restored = await inspectContainer(docker, command, authority.container_id);
  if (restored.Id !== authority.container_id || restored.Image !== authority.image_id || restored.State?.StartedAt !== authority.started_at || restored.State?.Running !== true || restored.State?.Paused !== false) throw new SpawnfileError("validation_error", "Managed source state restoration could not be proven");
};

export const issueProductStateSourceAuthority = async (input: { dockerCommand: string; container: string; sourceRunId: string; mountPath: string; candidateVolumeName: string; candidateResourceIdentity: string }, docker: DockerExec = defaultDockerExec): Promise<Record<string, unknown>> => {
  const inspected = await inspectContainer(docker, input.dockerCommand, input.container), labels = inspected.Config?.Labels, state = inspected.State;
  const mounts = Array.isArray(inspected.Mounts) ? inspected.Mounts.filter((mount: any) => mount.Type === "volume" && mount.Destination === input.mountPath && mount.RW === true) : [];
  if (inspected.Id?.length !== 64 || !/^sha256:[a-f0-9]{64}$/u.test(inspected.Image) || labels?.["com.spawnfile.run_id"] !== input.sourceRunId || state?.Running !== true || typeof state.StartedAt !== "string" || mounts.length !== 1 || typeof mounts[0].Source !== "string" || typeof mounts[0].Name !== "string") throw new SpawnfileError("validation_error", "Source run does not own one exact managed writable state root");
  const volume = JSON.parse((await docker(input.dockerCommand, ["volume", "inspect", input.candidateVolumeName])).stdout); if (!Array.isArray(volume) || volume.length !== 1 || typeof volume[0]?.Mountpoint !== "string") throw new SpawnfileError("validation_error", "Candidate volume is unavailable");
  return authoritySchema.parse({ version: "spawnfile.product-state-source-authority.v1", source_run_id: input.sourceRunId, container_id: inspected.Id, image_id: inspected.Image, started_at: state.StartedAt, was_paused: state.Paused === true, source: mounts[0].Source, mount_path: input.mountPath, volume_name: mounts[0].Name, candidate_volume_name: input.candidateVolumeName, candidate_resource_identity: input.candidateResourceIdentity });
};

const hashFile = async (file: string): Promise<string> => {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); try {
    const info = await handle.stat(); if (!info.isFile() || info.size > 67_108_864) throw new SpawnfileError("validation_error", "Product state file is unsafe or oversized");
    return `sha256:${createHash("sha256").update(await handle.readFile()).digest("hex")}`;
  } finally { await handle.close(); }
};
const syncDirectory = async (directory: string): Promise<void> => { const handle = await open(directory, constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); } };
const syncTreeDirectories = async (directory: string): Promise<void> => { for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await syncTreeDirectories(path.join(directory, entry.name)); await syncDirectory(directory); };

const wholeSourceManifest = async (root: string): Promise<Map<string, string>> => {
  const result = new Map<string, string>();
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if ([".spawnfile-product-state-write-fence", ".spawnfile-product-state-preseed-journal", ".spawnfile-resource-identity"].includes(relativePath)) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) { await visit(absolutePath, relativePath); continue; }
      if (!entry.isFile() || result.size >= 4096) throw new SpawnfileError("validation_error", "Product-state source contains an unsafe or excessive entry");
      result.set(relativePath, await hashFile(absolutePath));
    }
  };
  await visit(root, ""); return result;
};
const verifyWholeSourceManifest = async (root: string, proof: z.infer<typeof proofSchema>): Promise<void> => {
  const actual = await wholeSourceManifest(root), expected = new Map(proof.files.map((entry) => [entry.path, entry.sha256]));
  if (actual.size !== expected.size || [...actual].some(([name, checksum]) => expected.get(name) !== checksum)) throw new SpawnfileError("validation_error", "Whole product-state source manifest drifted or is incomplete");
};
export const createProductStateProof = async (source: string, sourceRunId: string): Promise<Record<string, unknown>> => {
  const manifest = await wholeSourceManifest(source); const files = [...manifest].sort(([left], [right]) => left.localeCompare(right)).map(([filePath, sha256]) => { if (forbidden.test(filePath)) throw new SpawnfileError("validation_error", "Product-state source includes prohibited state"); return { path: filePath, sha256 }; });
  return proofSchema.parse({ version: "spawnfile.product-state-quiescence.v1", state: "quiesced", source_run_id: sourceRunId, files });
};

export const issueProductStateSourceSnapshot = async (input: { dockerCommand: string; container: string; sourceRunId: string; mountPath: string; candidateVolumeName: string; candidateResourceIdentity: string }, docker: DockerExec = defaultDockerExec): Promise<{ authority: Record<string, unknown>; proof: Record<string, unknown> }> => {
  const authority = authoritySchema.parse(await issueProductStateSourceAuthority(input, docker)); let pausedByUs = false;
  try {
    if (!authority.was_paused) { await docker(input.dockerCommand, ["pause", authority.container_id]); pausedByUs = true; }
    const frozen = await inspectContainer(docker, input.dockerCommand, authority.container_id); if (frozen.Id !== authority.container_id || frozen.Image !== authority.image_id || frozen.State?.StartedAt !== authority.started_at || frozen.State?.Paused !== true) throw new SpawnfileError("validation_error", "Source changed before authoritative snapshot");
    return { authority, proof: await createProductStateProof(authority.source, authority.source_run_id) };
  } finally { if (pausedByUs) await restoreRunningState(docker, input.dockerCommand, authority); }
};

export const cloneQuiescedProductState = async (input: { source: string; destination: string; proof: unknown; candidateRunId: string; activationIdentity?: string }): Promise<{ files: number; source_run_id: string; candidate_run_id: string }> => {
  const proof = proofSchema.parse(input.proof); if (proof.source_run_id === input.candidateRunId) throw new SpawnfileError("validation_error", "Candidate state namespace must differ from source");
  const destinationExists = await stat(input.destination).then((info) => { if (!info.isDirectory()) throw new SpawnfileError("validation_error", "Candidate state destination is not a directory"); return true; }, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error));
  const journalPath = path.join(input.destination, ".spawnfile-product-state-preseed-journal");
  if (destinationExists && await stat(journalPath).then(() => true, () => false)) {
    const journal = z.object({ version: z.literal("spawnfile.product-state-preseed-journal.v1"), candidate_run_id: z.string(), entries: z.array(relative), staging: relative }).strict().parse(JSON.parse(await readFile(journalPath, "utf8")));
    if (journal.candidate_run_id !== input.candidateRunId) throw new SpawnfileError("validation_error", "Candidate preseed journal belongs to another run");
    const identityPath = path.join(input.destination, ".spawnfile-resource-identity"), activated = input.activationIdentity && await readFile(identityPath, "utf8").then((value) => value === `${input.activationIdentity}\n`, () => false);
    if (activated) { await verifyWholeSourceManifest(input.destination, proof); await rm(journalPath); await syncDirectory(input.destination); return { files: proof.files.length, source_run_id: proof.source_run_id, candidate_run_id: input.candidateRunId }; }
    for (const entry of [...journal.entries, journal.staging]) await rm(path.join(input.destination, entry), { recursive: true, force: true }); await rm(journalPath); await syncDirectory(input.destination);
  }
  if (destinationExists && (await readdir(input.destination)).length !== 0) throw new SpawnfileError("validation_error", "Candidate state destination is not empty");
  const names = new Set<string>(); for (const entry of proof.files) {
    if (forbidden.test(entry.path) || names.has(entry.path)) throw new SpawnfileError("validation_error", "Product-state classification contains a prohibited or duplicate path"); names.add(entry.path);
    if (await hashFile(path.join(input.source, entry.path)) !== entry.sha256) throw new SpawnfileError("validation_error", "Quiesced product-state checksum mismatch");
  }
  const temporary = destinationExists ? path.join(input.destination, `.spawnfile-preseed-${process.pid}`) : `${input.destination}.candidate-${process.pid}`; await mkdir(temporary, { recursive: false, mode: 0o700 });
  const activated: string[] = []; try {
    for (const entry of proof.files) { const target = path.join(temporary, entry.path); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await copyFile(path.join(input.source, entry.path), target, constants.COPYFILE_EXCL); const copied = await open(target, constants.O_RDONLY); try { await copied.sync(); } finally { await copied.close(); } if (await hashFile(target) !== entry.sha256 || await hashFile(path.join(input.source, entry.path)) !== entry.sha256) throw new SpawnfileError("validation_error", "Product state changed during clone"); }
    await syncTreeDirectories(temporary);
    if (destinationExists) {
      const entries = await readdir(temporary), journal = await open(journalPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); try { await journal.writeFile(`${JSON.stringify({ version: "spawnfile.product-state-preseed-journal.v1", candidate_run_id: input.candidateRunId, entries, staging: path.basename(temporary) })}\n`); await journal.sync(); } finally { await journal.close(); } await syncDirectory(input.destination);
      for (const entry of entries) { await rename(path.join(temporary, entry), path.join(input.destination, entry)); activated.push(path.join(input.destination, entry)); await syncDirectory(input.destination); }
      await rm(temporary, { recursive: true }); await syncDirectory(input.destination);
      await verifyWholeSourceManifest(input.destination, proof);
      if (input.activationIdentity) { const identity = await open(path.join(input.destination, ".spawnfile-resource-identity"), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); try { await identity.writeFile(`${input.activationIdentity}\n`); await identity.sync(); } finally { await identity.close(); } await syncDirectory(input.destination); }
      await rm(journalPath); await syncDirectory(input.destination);
    } else { await rename(temporary, input.destination); await syncDirectory(path.dirname(input.destination)); }
  } catch (error) {
    if (input.activationIdentity) { await rm(path.join(input.destination, ".spawnfile-resource-identity"), { force: true }); if (destinationExists) await syncDirectory(input.destination); }
    for (const entry of activated.reverse()) { await rm(entry, { recursive: true, force: true }); if (destinationExists) await syncDirectory(input.destination); }
    await rm(temporary, { recursive: true, force: true }); await syncDirectory(destinationExists ? input.destination : path.dirname(input.destination));
    await rm(journalPath, { force: true }); if (destinationExists) await syncDirectory(input.destination); throw error;
  }
  return { files: proof.files.length, source_run_id: proof.source_run_id, candidate_run_id: input.candidateRunId };
};

export const runProductStateCloneWorkflow = async (input: { authorityReceiptPath: string; dockerCommand: string; destination: string; proofPath: string; receiptPath: string; candidateRunId: string }, docker: DockerExec = defaultDockerExec): Promise<Record<string, unknown>> => {
  const authority = authoritySchema.parse(JSON.parse(await readFile(input.authorityReceiptPath, "utf8")));
  const candidateVolume = JSON.parse((await docker(input.dockerCommand, ["volume", "inspect", authority.candidate_volume_name])).stdout); if (!Array.isArray(candidateVolume) || candidateVolume.length !== 1 || candidateVolume[0]?.Mountpoint !== path.resolve(input.destination)) throw new SpawnfileError("validation_error", "Clone destination is not the attested candidate volume");
  const current = await inspectContainer(docker, input.dockerCommand, authority.container_id), currentMounts = Array.isArray(current.Mounts) ? current.Mounts : [];
  if (current.Id !== authority.container_id || current.Image !== authority.image_id || current.State?.StartedAt !== authority.started_at || current.Config?.Labels?.["com.spawnfile.run_id"] !== authority.source_run_id || current.State?.Running !== true || current.State?.Paused !== authority.was_paused || !currentMounts.some((mount: any) => mount.Type === "volume" && mount.Name === authority.volume_name && mount.Source === authority.source && mount.Destination === authority.mount_path && mount.RW === true)) throw new SpawnfileError("validation_error", "Source run authority is stale or rebound");
  const proofBytes = await readFile(input.proofPath); if (proofBytes.length > 1_048_576) throw new SpawnfileError("validation_error", "Product-state proof is oversized");
  const proof = proofSchema.parse(JSON.parse(proofBytes.toString("utf8")));
  if (proof.source_run_id !== authority.source_run_id) throw new SpawnfileError("validation_error", "Proof source run does not match managed authority");
  const fencePath = path.join(authority.source, ".spawnfile-product-state-write-fence");
  const fence = await open(fencePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
  const modes: Array<{ file: string; mode: number }> = []; let pausedByUs = false;
  try {
    await fence.writeFile(`${proof.source_run_id}\n`); await fence.sync();
    if (!authority.was_paused) { await docker(input.dockerCommand, ["pause", authority.container_id]); pausedByUs = true; }
    const frozen = await inspectContainer(docker, input.dockerCommand, authority.container_id); if (frozen.State?.Paused !== true || frozen.State?.StartedAt !== authority.started_at || frozen.Id !== authority.container_id) throw new SpawnfileError("validation_error", "Managed source cgroup did not freeze exactly");
    await verifyWholeSourceManifest(authority.source, proof);
    for (const entry of proof.files) {
      if (forbidden.test(entry.path)) throw new SpawnfileError("validation_error", "Product-state classification contains a prohibited path");
      const file = path.join(authority.source, entry.path), info = await stat(file); modes.push({ file, mode: info.mode & 0o777 }); await chmod(file, info.mode & ~0o222);
    }
    const cloned = await cloneQuiescedProductState({ source: authority.source, destination: input.destination, proof, candidateRunId: input.candidateRunId, activationIdentity: authority.candidate_resource_identity });
    await verifyWholeSourceManifest(authority.source, proof);
    await verifyWholeSourceManifest(input.destination, proof);
    const receipt = { version: "spawnfile.product-state-clone-receipt.v1", ...cloned, proof_sha256: `sha256:${createHash("sha256").update(proofBytes).digest("hex")}`, destination: path.resolve(input.destination), candidate_volume_name: authority.candidate_volume_name, source_container_id: authority.container_id };
    const temporaryReceipt = `${input.receiptPath}.tmp-${process.pid}`; await mkdir(path.dirname(input.receiptPath), { recursive: true, mode: 0o700 }); let published = false;
    try {
      const receiptFile = await open(temporaryReceipt, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { await receiptFile.writeFile(`${JSON.stringify(receipt)}\n`); await receiptFile.sync(); } finally { await receiptFile.close(); }
      await link(temporaryReceipt, input.receiptPath); published = true; const receiptDirectory = await open(path.dirname(input.receiptPath), constants.O_RDONLY); try { await receiptDirectory.sync(); } finally { await receiptDirectory.close(); } await rm(temporaryReceipt); await syncDirectory(path.dirname(input.receiptPath));
    } catch (error) { await rm(temporaryReceipt, { force: true }); await syncDirectory(path.dirname(input.receiptPath)); if (published) { await rm(input.receiptPath, { force: true }); await syncDirectory(path.dirname(input.receiptPath)); } for (const entry of await readdir(input.destination)) { await rm(path.join(input.destination, entry), { recursive: true, force: true }); await syncDirectory(input.destination); } throw error; }
    return receipt;
  } finally {
    let restorationError: unknown;
    for (const item of modes.reverse()) try { await chmod(item.file, item.mode); } catch (error) { restorationError ??= error; }
    try { await fence.close(); await rm(fencePath, { force: true }); await syncDirectory(authority.source); } catch (error) { restorationError ??= error; }
    try { if (pausedByUs) await restoreRunningState(docker, input.dockerCommand, authority); } catch (error) { restorationError ??= error; }
    if (restorationError) throw new SpawnfileError("validation_error", "Product-state source restoration failed", { cause: restorationError });
  }
};
