import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cloneQuiescedProductState, createProductStateProof, issueProductStateSourceAuthority, issueProductStateSourceSnapshot, runProductStateCloneWorkflow } from "./productStateClone.js";

const sha = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
describe("classified product-state clone", () => {
  it("copies only checksummed quiesced product files into a fresh namespace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-state-clone-")); try {
      const source = path.join(root, "source"), destination = path.join(root, "candidate"); await import("node:fs/promises").then(({ mkdir }) => mkdir(source));
      await writeFile(path.join(source, "edition.json"), "edition"); await writeFile(path.join(source, "token.json"), "secret");
      const proof = { version: "spawnfile.product-state-quiescence.v1", state: "quiesced", source_run_id: "r28", files: [{ path: "edition.json", sha256: sha("edition") }] };
      await expect(cloneQuiescedProductState({ source, destination, proof, candidateRunId: "candidate" })).resolves.toMatchObject({ files: 1 });
      expect(await readFile(path.join(destination, "edition.json"), "utf8")).toBe("edition");
      await expect(readFile(path.join(destination, "token.json"))).rejects.toThrow();
      await expect(cloneQuiescedProductState({ source, destination: path.join(root, "bad"), proof: { ...proof, files: [{ path: "state.sqlite", sha256: sha("") }] }, candidateRunId: "candidate2" })).rejects.toThrow(/prohibited/u);
      await expect(cloneQuiescedProductState({ source, destination: path.join(root, "same"), proof, candidateRunId: "r28" })).rejects.toThrow(/differ/u);
      await expect(cloneQuiescedProductState({ source, destination, proof, candidateRunId: "candidate3" })).rejects.toThrow(/not empty/u);
      await expect(cloneQuiescedProductState({ source, destination: path.join(root, "drift"), proof: { ...proof, files: [{ path: "edition.json", sha256: sha("wrong") }] }, candidateRunId: "candidate4" })).rejects.toThrow(/checksum mismatch/u);
      await expect(cloneQuiescedProductState({ source, destination: path.join(root, "auth"), proof: { ...proof, files: [{ path: "session/data.json", sha256: sha("") }] }, candidateRunId: "candidate5" })).rejects.toThrow(/prohibited/u);
      await expect(cloneQuiescedProductState({ source, destination: path.join(root, "grok-auth"), proof: { ...proof, files: [{ path: ".grok/auth.json", sha256: sha("") }] }, candidateRunId: "candidate-auth" })).rejects.toThrow(/prohibited/u);
      await expect(cloneQuiescedProductState({ source, destination: path.join(root, "duplicate"), proof: { ...proof, files: [proof.files[0], proof.files[0]] }, candidateRunId: "candidate6" })).rejects.toThrow(/duplicate/u);
      await mkdir(path.join(source, "directory"));
      await expect(cloneQuiescedProductState({ source, destination: path.join(root, "directory-source"), proof: { ...proof, files: [{ path: "directory", sha256: sha("") }] }, candidateRunId: "candidate7" })).rejects.toThrow(/unsafe or oversized/u);
      const recovered = path.join(root, "recovered"); await mkdir(path.join(recovered, ".spawnfile-preseed-77"), { recursive: true }); await writeFile(path.join(recovered, "edition.json"), "partial"); await writeFile(path.join(recovered, ".spawnfile-product-state-preseed-journal"), JSON.stringify({ version: "spawnfile.product-state-preseed-journal.v1", candidate_run_id: "candidate8", entries: ["edition.json"], staging: ".spawnfile-preseed-77" }));
      await expect(cloneQuiescedProductState({ source, destination: recovered, proof, candidateRunId: "candidate8", activationIdentity: `sha256:${"f".repeat(64)}` })).resolves.toMatchObject({ files: 1 }); expect(await readFile(path.join(recovered, "edition.json"), "utf8")).toBe("edition");
      const finalized = path.join(root, "finalized"), finalIdentity = `sha256:${"e".repeat(64)}`; await mkdir(finalized); await writeFile(path.join(finalized, "edition.json"), "edition"); await writeFile(path.join(finalized, ".spawnfile-resource-identity"), `${finalIdentity}\n`); await writeFile(path.join(finalized, ".spawnfile-product-state-preseed-journal"), JSON.stringify({ version: "spawnfile.product-state-preseed-journal.v1", candidate_run_id: "candidate9", entries: ["edition.json"], staging: ".spawnfile-preseed-88" })); await expect(cloneQuiescedProductState({ source, destination: finalized, proof, candidateRunId: "candidate9", activationIdentity: finalIdentity })).resolves.toMatchObject({ files: 1 });
      const wrongJournal = path.join(root, "wrong-journal"); await mkdir(wrongJournal); await writeFile(path.join(wrongJournal, ".spawnfile-product-state-preseed-journal"), JSON.stringify({ version: "spawnfile.product-state-preseed-journal.v1", candidate_run_id: "another", entries: [], staging: ".spawnfile-preseed-99" })); await expect(cloneQuiescedProductState({ source, destination: wrongJournal, proof, candidateRunId: "candidate10" })).rejects.toThrow(/another run/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("mechanically fences writes, emits a receipt, and rolls activation back when receipt publication fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-state-workflow-")); try {
      const source = path.join(root, "source"); await mkdir(path.join(source, "nested"), { recursive: true }); await writeFile(path.join(source, "nested/edition.json"), "edition");
      const proofPath = path.join(root, "proof.json"), receiptPath = path.join(root, "receipt.json"), authorityReceiptPath = path.join(root, "authority.json");
      const containerId = "a".repeat(64), imageId = `sha256:${"b".repeat(64)}`, startedAt = "2026-08-25T00:00:00Z", candidateVolumeName = "candidate-volume", destination = path.join(root, "candidate"); let paused = false;
      const inspect = () => [{ Id: containerId, Image: imageId, State: { Running: true, Paused: paused, StartedAt: startedAt }, Config: { Labels: { "com.spawnfile.run_id": "live" } }, Mounts: [{ Type: "volume", Name: "live-volume", Source: source, Destination: "/product", RW: true }] }];
      const docker = async (_command: string, args: string[]) => { if (args[0] === "inspect") return { stdout: JSON.stringify(inspect()) }; if (args[0] === "volume") return { stdout: JSON.stringify([{ Mountpoint: destination }]) }; if (args[0] === "pause") { paused = true; return { stdout: "" }; } if (args[0] === "unpause") { paused = false; return { stdout: "" }; } throw new Error("unexpected docker call"); };
      await expect(issueProductStateSourceSnapshot({ dockerCommand: "docker", container: "live", sourceRunId: "unrelated", mountPath: "/product", candidateVolumeName, candidateResourceIdentity: `sha256:${"c".repeat(64)}` }, docker)).rejects.toThrow(/does not own/u);
      paused = true; await expect(issueProductStateSourceSnapshot({ dockerCommand: "docker", container: "live", sourceRunId: "live", mountPath: "/product", candidateVolumeName, candidateResourceIdentity: `sha256:${"c".repeat(64)}` }, docker)).resolves.toBeTruthy(); expect(paused).toBe(true); paused = false;
      const snapshot = await issueProductStateSourceSnapshot({ dockerCommand: "docker", container: "live", sourceRunId: "live", mountPath: "/product", candidateVolumeName, candidateResourceIdentity: `sha256:${"c".repeat(64)}` }, docker), authority = snapshot.authority; await writeFile(authorityReceiptPath, JSON.stringify(authority));
      await writeFile(proofPath, JSON.stringify(snapshot.proof));
      await writeFile(path.join(source, "unlisted.json"), "drift");
      await mkdir(destination);
      await expect(runProductStateCloneWorkflow({ authorityReceiptPath, dockerCommand: "docker", destination, proofPath, receiptPath: path.join(root, "incomplete-receipt"), candidateRunId: "incomplete" }, docker)).rejects.toThrow(/manifest/u);
      await rm(path.join(source, "unlisted.json"));
      await expect(runProductStateCloneWorkflow({ authorityReceiptPath, dockerCommand: "docker", destination, proofPath, receiptPath, candidateRunId: "candidate" }, docker)).resolves.toMatchObject({ version: "spawnfile.product-state-clone-receipt.v1", candidate_volume_name: candidateVolumeName });
      expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({ candidate_run_id: "candidate" });
      await writeFile(path.join(source, ".spawnfile-product-state-write-fence"), "busy");
      await expect(runProductStateCloneWorkflow({ authorityReceiptPath, dockerCommand: "docker", destination: path.join(root, "blocked"), proofPath, receiptPath: path.join(root, "blocked-receipt"), candidateRunId: "blocked" }, docker)).rejects.toThrow();
      await rm(path.join(source, ".spawnfile-product-state-write-fence")); await writeFile(path.join(root, "occupied-receipt"), "occupied");
      await rm(destination, { recursive: true }); const rollbackDestination = path.join(root, "rolled-back"); await mkdir(rollbackDestination); const rollbackDocker = async (command: string, args: string[]) => args[0] === "volume" ? { stdout: JSON.stringify([{ Mountpoint: rollbackDestination }]) } : docker(command, args);
      await expect(runProductStateCloneWorkflow({ authorityReceiptPath, dockerCommand: "docker", destination: rollbackDestination, proofPath, receiptPath: path.join(root, "occupied-receipt"), candidateRunId: "rollback" }, rollbackDocker)).rejects.toThrow();
      expect(await readdir(rollbackDestination)).toEqual([]);
      const stale = { ...authority, started_at: "reused" }; await writeFile(authorityReceiptPath, JSON.stringify(stale)); await expect(runProductStateCloneWorkflow({ authorityReceiptPath, dockerCommand: "docker", destination: rollbackDestination, proofPath, receiptPath: path.join(root, "stale-receipt"), candidateRunId: "stale" }, rollbackDocker)).rejects.toThrow(/stale or rebound/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("fails closed when Docker authority or the frozen identity is malformed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "spawnfile-state-authority-")); try {
      const source = path.join(root, "source"), destination = path.join(root, "candidate"); await mkdir(source); await writeFile(path.join(source, "edition.json"), "edition");
      const input = { dockerCommand: "docker", container: "live", sourceRunId: "live", mountPath: "/product", candidateVolumeName: "candidate", candidateResourceIdentity: `sha256:${"c".repeat(64)}` };
      await expect(issueProductStateSourceAuthority(input, async () => ({ stdout: "{}" }))).rejects.toThrow(/inspection failed/u);
      const id = "a".repeat(64), image = `sha256:${"b".repeat(64)}`, started = "2026-08-25T00:00:00Z"; let paused = false;
      const inspect = () => [{ Id: id, Image: image, State: { Running: true, Paused: paused, StartedAt: started }, Config: { Labels: { "com.spawnfile.run_id": "live" } }, Mounts: [{ Type: "volume", Name: "live-volume", Source: source, Destination: "/product", RW: true }] }];
      const unavailable = async (_command: string, args: string[]) => ({ stdout: args[0] === "inspect" ? JSON.stringify(inspect()) : "[]" });
      await expect(issueProductStateSourceAuthority(input, unavailable)).rejects.toThrow(/volume is unavailable/u);
      const changedAfterPause = async (_command: string, args: string[]) => {
        if (args[0] === "volume") return { stdout: JSON.stringify([{ Mountpoint: destination }]) };
        if (args[0] === "pause") { paused = true; return { stdout: "" }; }
        if (args[0] === "unpause") { paused = false; return { stdout: "" }; }
        const value = inspect(); if (paused) value[0].Image = `sha256:${"d".repeat(64)}`; return { stdout: JSON.stringify(value) };
      };
      await expect(issueProductStateSourceSnapshot(input, changedAfterPause)).rejects.toThrow(/changed before/u); expect(paused).toBe(false);
      const cannotRestore = async (command: string, args: string[]) => { if (args[0] === "unpause") throw new Error("restore failed"); return changedAfterPause(command, args); };
      await expect(issueProductStateSourceSnapshot(input, cannotRestore)).rejects.toThrow(/restore failed/u);
      await writeFile(path.join(source, "access-token.json"), "secret");
      await expect(createProductStateProof(source, "live")).rejects.toThrow(/prohibited/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
