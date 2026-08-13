import { chmod, chown, lstat, mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseOpaqueTargetHandle, TARGET_RESOURCE_REQUEST_VERSION } from "./contracts.js";
import { admission, cleanupTestRoots, complete, header, runLifecycleExport } from "./evidenceExportOperationsTestKit.js";
import { initializeEvidenceExportAuthorityStore } from "./evidenceExportStore.js";
import { createDockerArtifactSpec, initializeDockerArtifactIdentityStore } from "./dockerArtifactsProvider.js";
import { createDockerResourceSpec } from "./dockerResourcesProvider.js";
import { createEvidenceExportOperations, isEvidenceExportIncomplete } from "./evidenceExport.js";
import { initializeTargetJournal, type TargetJournalStore } from "./journal.js";
import { selectTarget } from "./dockerTarget.js";
import { EVIDENCE_EXPORT_HELPER_CONTRACT } from "./evidenceExportProvider.js";

const roots: string[] = [];
const fixtureRoot = async (): Promise<string> => {
  const value = await realpath(await mkdtemp(path.join(os.tmpdir(), "spawnfile-export-")));
  roots.push(value);
  return value;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { force: true, recursive: true })));
  await cleanupTestRoots();
});

describe("evidence export operation authority", () => {
  it("preserves a non-incomplete export failure as cause and message text", async () => {
    const fixture = await runLifecycleExport({ startShouldFail: true });
    await expect(fixture.execute()).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof Error)) return false;
      return error.message.includes("start failed")
        && error.cause instanceof Error
        && error.cause.message.includes("start failed");
    });
  });

  it("replays a completed export from durable evidence without live Docker access", async () => {
    const fixture = await runLifecycleExport();
    const completed = await fixture.execute();
    const callsAfterCompletion = fixture.calls.length;
    const exportsAfterCompletion = fixture.getExportCalls();

    const replay = await fixture.executeReplayWithBlockedExecutors();

    expect(replay.result).toEqual(completed);
    expect(replay.dockerCalls).toBe(0);
    expect(replay.exportCalls).toBe(0);
    expect(fixture.calls).toHaveLength(callsAfterCompletion);
    expect(fixture.getExportCalls()).toBe(exportsAfterCompletion);
  });

  it("rejects completed replay when helper request provenance drifts without live Docker access", async () => {
    const fixture = await runLifecycleExport();
    await fixture.execute();

    const replay = await fixture.rejectReplayWithWrongHelperRequest();

    expect(replay.error).toBeInstanceOf(Error);
    expect((replay.error as Error).message).toContain("Evidence-volume export failed: SpawnfileError: Evidence-volume export failed");
    expect(replay.dockerCalls).toBe(0);
    expect(replay.exportCalls).toBe(0);
  });

  it("accepts only an exact private root and exact private authority files", async () => {
    const directory = await fixtureRoot();
    const value = admission();
    const filesystemRootBefore = await lstat("/");
    await expect(initializeEvidenceExportAuthorityStore("/")).rejects.toThrow("Evidence-volume export failed");
    expect((await lstat("/")).mode).toBe(filesystemRootBefore.mode);

    const store = await initializeEvidenceExportAuthorityStore(directory);
    await expect(stat(directory)).resolves.toHaveProperty("mode", expect.any(Number));
    await chmod(directory, 0o755);
    await expect(initializeEvidenceExportAuthorityStore(directory)).rejects.toThrow("Evidence-volume export failed");
    await chmod(directory, 0o700);

    const restored = await initializeEvidenceExportAuthorityStore(directory);
    await restored.bindAdmission(value);
    await restored.bindDestination(value, "/operator/private/match.tar");
    const files = await readdir(directory);
    const admissionFile = files.find((file) => file.endsWith(".admission.json"));
    const keyFile = files.find((file) => file === ".destination-hmac.key");
    expect(admissionFile).toBeDefined();
    expect(keyFile).toBeDefined();
    for (const [file, read] of [
      [admissionFile!, () => restored.loadAdmission(value.operation_handle)],
      [keyFile!, () => restored.requireDestination(value, "/operator/private/match.tar")]
    ] as const) {
      for (const mode of [0o700, 0o400]) {
        await chmod(`${directory}/${file}`, mode);
        await expect(read()).rejects.toThrow("Evidence-volume export failed");
      }
      await chmod(`${directory}/${file}`, 0o600);
    }
    await expect(restored.requireDestination(value, "/operator/private/match.tar")).resolves.toBeUndefined();
  });

  it("rejects an owner-wrong existing private root where the platform permits ownership changes", async () => {
    if ((process.getuid?.() ?? -1) !== 0) return;
    const directory = await fixtureRoot();
    await initializeEvidenceExportAuthorityStore(directory);
    await chown(directory, 1, -1);
    await expect(initializeEvidenceExportAuthorityStore(directory)).rejects.toThrow("Evidence-volume export failed");
    await chown(directory, 0, -1);
  });

  it("commits one opaque destination binding across store instances without persisting its path", async () => {
    const directory = await fixtureRoot();
    const value = admission();
    const destination = "/operator/private/match.tar";
    const first = await initializeEvidenceExportAuthorityStore(directory);
    await first.bindAdmission(value);
    await first.bindDestination(value, destination);
    await first.requireDestination(value, destination);
    const second = await initializeEvidenceExportAuthorityStore(directory);
    await second.requireDestination(value, destination);
    await expect(second.requireDestination(value, "/operator/private/other.tar")).rejects.toThrow("Evidence-volume export failed");
    const files = await readdir(directory);
    const text = await Promise.all(files.map(async (file) => readFile(`${directory}/${file}`, "utf8")));
    expect(text.join("\n")).not.toContain(destination);
    expect(text.join("\n")).not.toContain("match.tar");
    expect(await stat(`${directory}/.destination-hmac.key`).then((value) => value.mode & 0o777)).toBe(0o600);
  });

  it("rejects authority drift before a destination can be reused", async () => {
    const directory = await fixtureRoot();
    const value = admission();
    const store = await initializeEvidenceExportAuthorityStore(directory);
    await store.bindAdmission(value);
    await store.bindDestination(value, "/operator/private/match.tar");
    await expect(store.requireDestination({ ...value, descriptor_digest: `sha256:${"f".repeat(64)}` }, "/operator/private/match.tar")).rejects.toThrow("Evidence-volume export failed");
    await expect(store.bindAdmission({ ...value, evidence_volume: { ...value.evidence_volume, resultHandle: parseOpaqueTargetHandle("opaque_eeeeeeeeeeeeeeee") } })).rejects.toThrow("Evidence-volume export failed");
  });

  it("returns incomplete for pending journal reservations before any helper work", async () => {
    const directory = await fixtureRoot();
    const context = "test_context";
    const descriptor = `sha256:${"a".repeat(64)}`;
    const manifest = `sha256:${"b".repeat(64)}`;
    const image = `sha256:${"c".repeat(64)}`;
    const reference = `registry.example/export@${image}`;
    const calls: string[][] = [];
    const executor = async (_file: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "context") return { stderr: "", stdout: JSON.stringify("unix:///private/test.sock") };
      throw new Error("unexpected docker invocation");
    };
    const selected = await selectTarget({ context, execFile: executor });
    const journal = await initializeTargetJournal({ context, descriptorDigest: descriptor, root: `${directory}/journal`, runId: "run-one", selectedTarget: selected });
    const envelope = (expected_revision: number, idempotency_key: string) => ({ descriptor_digest: descriptor, expected_revision, idempotency_key, run_id: "run-one", selected_target: { fingerprint: selected.fingerprint, handle: selected.handle }, version: TARGET_RESOURCE_REQUEST_VERSION });
    const artifactRequest = { ...envelope(0, "idem_aaaaaaaaaaaaaaaa"), artifact_manifest_digest: manifest, operation: "resolve_world_artifact" as const };
    const artifactClaim = await journal.reserve(artifactRequest);
    if (artifactClaim.kind !== "owner") throw new Error("artifact reservation failed");
    const artifact = createDockerArtifactSpec({ artifactManifestDigest: manifest, imageDigest: image, imageReference: reference, operationHandle: artifactClaim.claim.operationHandle, requestDigest: artifactClaim.claim.requestDigest, selectedTargetHandle: selected.handle });
    await complete(journal, artifactClaim.claim, artifactRequest, artifact);

    const identities = await initializeDockerArtifactIdentityStore(`${directory}/identities`);
    await identities.bind({ artifactManifestDigest: manifest, imageDigest: image, imageReference: reference, operationHandle: artifactClaim.claim.operationHandle, requestDigest: artifactClaim.claim.requestDigest, resultHandle: artifact.resultHandle, selectedTargetHandle: selected.handle });

    const volumeRequest = { ...envelope(1, "idem_bbbbbbbbbbbbbbbb"), operation: "create_evidence_volume" as const };
    const volumeClaim = await journal.reserve(volumeRequest);
    if (volumeClaim.kind !== "owner") throw new Error("volume reservation failed");
    const volume = createDockerResourceSpec({ kind: "evidence_volume", operationHandle: volumeClaim.claim.operationHandle, requestDigest: volumeClaim.claim.requestDigest, runId: "run-one", selectedTargetHandle: selected.handle });
    await complete(journal, volumeClaim.claim, volumeRequest, volume);

    const exportRequest = { ...envelope(2, "idem_cccccccccccccccc"), evidence_volume_handle: volume.resultHandle, operation: "export_evidence_volume" as const };
    const pendingClaim = await journal.reserve(exportRequest);
    if (pendingClaim.kind !== "owner") throw new Error("pending reservation failed");
    const pendingRevision = (await journal.read()).revision;
    const operations = createEvidenceExportOperations({
      authorityStore: await initializeEvidenceExportAuthorityStore(`${directory}/export-store`),
      artifactIdentityStore: identities,
      context,
      executor,
      exportExecutor: async () => { throw new Error("should not execute"); },
      helperArtifactBundle: { operation_handle: artifactClaim.claim.operationHandle, request_digest: artifactClaim.claim.requestDigest, result_handle: artifact.resultHandle },
      helperArtifactManifestDigest: manifest,
      helperArtifactContract: EVIDENCE_EXPORT_HELPER_CONTRACT,
      journal
    });

    const destination = `${directory}/pending.tar`;
    await expect(operations.execute(exportRequest, destination)).rejects.toSatisfy((error: unknown) => isEvidenceExportIncomplete(error));
    expect(calls).toHaveLength(1);
    expect((await journal.read()).revision).toBe(pendingRevision);
  });

  it("replays only the committed destination after B91 resolves the helper", async () => {
    const directory = await fixtureRoot();
    const context = "test_context";
    const descriptor = `sha256:${"a".repeat(64)}`;
    const manifest = `sha256:${"b".repeat(64)}`;
    const image = `sha256:${"c".repeat(64)}`;
    const reference = `registry.example/export@${image}`;
    const calls: string[][] = [];
    const archive = new Uint8Array([...header("ball", Buffer.from("kick")), ...Buffer.from("kick"), ...Buffer.alloc(508), ...Buffer.alloc(1024)]);
    let volume: ReturnType<typeof createDockerResourceSpec>;
    let created: string[] = [];
    const projection = JSON.stringify([{
      RepoDigests: [reference],
      Config: {
        Entrypoint: ["/bin/spawnfile-export-helper"],
        Cmd: [],
        Labels: { "spawnfile.target.evidence-export.helper-contract": "v1" },
        Env: null,
        ExposedPorts: null,
        Healthcheck: null,
        User: "65534:65534",
        Volumes: null
      }
    }]);
    const executor = async (_file: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "context") return { stderr: "", stdout: JSON.stringify("unix:///private/test.sock") };
      if (args[2] === "volume" && args[3] === "inspect") return { stderr: "", stdout: JSON.stringify([{ Labels: volume!.labels, Name: volume!.name }]) };
      if (args[2] === "image" && args[3] === "inspect") return { stderr: "", stdout: projection };
      if (args[2] === "container" && args[3] === "create") {
        created = args;
        return { stderr: "", stdout: "container" };
      }
      if (args[2] === "container" && args[3] === "inspect") {
        const command = created[created.indexOf("--name") + 1]!;
        return { stderr: "", stdout: JSON.stringify([{ Name: `/${command}`, Config: { Entrypoint: ["/bin/spawnfile-export-helper"], Cmd: [], Labels: { "spawnfile.target.evidence-export.helper-contract": "v1" }, User: "65534:65534", Image: reference, Env: null, ExposedPorts: null, Healthcheck: null, Volumes: null }, HostConfig: { AutoRemove: false, NetworkMode: "none", ReadonlyRootfs: true, Privileged: false, CapAdd: null, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges=true"], PidsLimit: 64, Memory: 134217728, NanoCpus: 250_000_000, IpcMode: "none", PidMode: "", UTSMode: "", UsernsMode: "", CgroupnsMode: "private", Binds: null, VolumesFrom: null, ExtraHosts: null, Dns: null, Links: null, GroupAdd: null, Devices: null, DeviceRequests: null, PortBindings: null, PublishAllPorts: false, RestartPolicy: { Name: "no", MaximumRetryCount: 0 }, LogConfig: { Type: "none", Config: {} } }, Mounts: [{ Type: "volume", Name: volume!.name, Destination: "/spawnfile/evidence", RW: false }] }]) };
      }
      if (args[2] === "container" && args[3] === "rm") return { stderr: "", stdout: "removed" };
      throw new Error("unexpected docker invocation");
    };
    const selected = await selectTarget({ context, execFile: executor });
    const journal = await initializeTargetJournal({ context, descriptorDigest: descriptor, root: `${directory}/journal`, runId: "run-one", selectedTarget: selected });
    const envelope = (expected_revision: number, idempotency_key: string) => ({ descriptor_digest: descriptor, expected_revision, idempotency_key, run_id: "run-one", selected_target: { fingerprint: selected.fingerprint, handle: selected.handle }, version: TARGET_RESOURCE_REQUEST_VERSION });
    const artifactRequest = { ...envelope(0, "idem_aaaaaaaaaaaaaaaa"), artifact_manifest_digest: manifest, operation: "resolve_world_artifact" as const };
    const artifactClaim = await journal.reserve(artifactRequest);
    if (artifactClaim.kind !== "owner") throw new Error("artifact");
    const artifact = createDockerArtifactSpec({ artifactManifestDigest: manifest, imageDigest: image, imageReference: reference, operationHandle: artifactClaim.claim.operationHandle, requestDigest: artifactClaim.claim.requestDigest, selectedTargetHandle: selected.handle });
    await complete(journal, artifactClaim.claim, artifactRequest, artifact);
    const identities = await initializeDockerArtifactIdentityStore(`${directory}/identities`);
    await identities.bind({ artifactManifestDigest: manifest, imageDigest: image, imageReference: reference, operationHandle: artifactClaim.claim.operationHandle, requestDigest: artifactClaim.claim.requestDigest, resultHandle: artifact.resultHandle, selectedTargetHandle: selected.handle });
    const volumeRequest = { ...envelope(1, "idem_bbbbbbbbbbbbbbbb"), operation: "create_evidence_volume" as const };
    const volumeClaim = await journal.reserve(volumeRequest);
    if (volumeClaim.kind !== "owner") throw new Error("volume");
    volume = createDockerResourceSpec({ kind: "evidence_volume", operationHandle: volumeClaim.claim.operationHandle, requestDigest: volumeClaim.claim.requestDigest, runId: "run-one", selectedTargetHandle: selected.handle });
    await complete(journal, volumeClaim.claim, volumeRequest, volume);
    const exportRequest = { ...envelope(2, "idem_cccccccccccccccc"), evidence_volume_handle: volume.resultHandle, operation: "export_evidence_volume" as const };
    const destination = `${directory}/blocked.tar`;
    const storeRoot = `${directory}/export-store`;
    let exportCalls = 0;
    const options = async (root = storeRoot) => ({
      authorityStore: await initializeEvidenceExportAuthorityStore(root),
      artifactIdentityStore: identities,
      context,
      executor,
      exportExecutor: async () => { exportCalls += 1; return { bytes: archive }; },
      helperArtifactBundle: { operation_handle: artifactClaim.claim.operationHandle, request_digest: artifactClaim.claim.requestDigest, result_handle: artifact.resultHandle },
      helperArtifactManifestDigest: manifest,
      helperArtifactContract: EVIDENCE_EXPORT_HELPER_CONTRACT,
      journal
    });
    const beforeQCalls = calls.length;
    const beforeQExports = exportCalls;
    const beforeQFiles = await readdir(storeRoot).catch(() => []);
    const beforeQRevision = (await journal.read()).revision;
    const owner = createEvidenceExportOperations({ ...(await options(`${directory}/export-store-success`)) });
    await expect(createEvidenceExportOperations({ ...(await options(storeRoot)) }).execute(exportRequest, destination)).rejects.toThrow("Evidence-volume export failed");
    expect(calls.length).toBeGreaterThan(beforeQCalls);
    expect(exportCalls).toBe(beforeQExports);
    expect((await journal.read()).revision).toBe(beforeQRevision);
    const afterQCalls = calls.length;
    expect(exportCalls).toBe(beforeQExports);
    expect((await readdir(storeRoot)).length).toBeGreaterThanOrEqual(beforeQFiles.length);
    await expect(owner.execute(exportRequest, destination)).rejects.toSatisfy((error: unknown) => isEvidenceExportIncomplete(error));
    expect(calls.length).toBe(afterQCalls);
  });

  it("rejects every unproven B91 helper before image, helper, export, or destination effects", async () => {
    const cases = ["missing", "wrong_operation", "wrong_request", "wrong_bundle_result", "forged_result", "not_completed", "wrong_run", "wrong_target", "wrong_descriptor", "wrong_manifest", "wrong_contract", "bad_deterministic", "wrong_selected"] as const;
    for (const kind of cases) {
      const directory = await fixtureRoot();
      const context = "test_context";
      const descriptor = `sha256:${"a".repeat(64)}`;
      const manifest = `sha256:${"b".repeat(64)}`;
      const image = `sha256:${"c".repeat(64)}`;
      const reference = `registry.example/export@${image}`;
      const calls: string[][] = [];
      let volume: ReturnType<typeof createDockerResourceSpec>;
      const executor = async (_file: string, args: string[]) => {
        calls.push(args);
        if (args[0] === "context") return { stderr: "", stdout: JSON.stringify("unix:///private/test.sock") };
        if (args[2] === "volume" && args[3] === "inspect") return { stderr: "", stdout: JSON.stringify([{ Labels: volume!.labels, Name: volume!.name }]) };
        throw new Error("helper must not be reached");
      };
      const selected = await selectTarget({ context, execFile: executor });
      const journal = await initializeTargetJournal({ context, descriptorDigest: descriptor, root: `${directory}/journal`, runId: "run-one", selectedTarget: selected });
      const envelope = (expected_revision: number, idempotency_key: string) => ({ descriptor_digest: descriptor, expected_revision, idempotency_key, run_id: "run-one", selected_target: { fingerprint: selected.fingerprint, handle: selected.handle }, version: TARGET_RESOURCE_REQUEST_VERSION });
      const artifactRequest = { ...envelope(0, "idem_aaaaaaaaaaaaaaaa"), artifact_manifest_digest: manifest, operation: "resolve_world_artifact" as const };
      const artifactClaim = await journal.reserve(artifactRequest);
      if (artifactClaim.kind !== "owner") throw new Error("artifact");
      const alternateTarget = parseOpaqueTargetHandle("opaque_eeeeeeeeeeeeeeee");
      const forgedHandle = parseOpaqueTargetHandle("opaque_ffffffffffffffff");
      const normal = createDockerArtifactSpec({ artifactManifestDigest: manifest, imageDigest: image, imageReference: reference, operationHandle: artifactClaim.claim.operationHandle, requestDigest: artifactClaim.claim.requestDigest, selectedTargetHandle: selected.handle });
      await complete(journal, artifactClaim.claim, artifactRequest, normal);
      const identities = await initializeDockerArtifactIdentityStore(`${directory}/identities`);
      if (kind !== "missing") {
        await identities.bind({ artifactManifestDigest: manifest, imageDigest: image, imageReference: reference, operationHandle: artifactClaim.claim.operationHandle, requestDigest: artifactClaim.claim.requestDigest, resultHandle: kind === "bad_deterministic" ? forgedHandle : normal.resultHandle, selectedTargetHandle: kind === "wrong_selected" ? alternateTarget : selected.handle });
      }
      const volumeRequest = { ...envelope(1, "idem_bbbbbbbbbbbbbbbb"), operation: "create_evidence_volume" as const };
      const volumeClaim = await journal.reserve(volumeRequest);
      if (volumeClaim.kind !== "owner") throw new Error("volume");
      volume = createDockerResourceSpec({ kind: "evidence_volume", operationHandle: volumeClaim.claim.operationHandle, requestDigest: volumeClaim.claim.requestDigest, runId: "run-one", selectedTargetHandle: selected.handle });
      await complete(journal, volumeClaim.claim, volumeRequest, volume);
      const exportRequest = { ...envelope(2, "idem_cccccccccccccccc"), evidence_volume_handle: volume.resultHandle, operation: "export_evidence_volume" as const };
      const resultHandle = kind === "bad_deterministic" ? forgedHandle : normal.resultHandle;
      const proxy: TargetJournalStore = {
        withLifecycleLease: (action) => journal.withLifecycleLease(action),
        complete: (claim, value) => journal.complete(claim, value),
        read: () => journal.read(),
        reserve: (raw) => journal.reserve(raw),
        resolveCompletedReceipt: async (claim) => {
          const resolved = await journal.resolveCompletedReceipt(claim);
          if (!resolved || kind === "not_completed") return kind === "not_completed" ? null : resolved;
          const receipt = structuredClone(resolved.receipt) as Record<string, unknown>;
          if (kind === "forged_result" || kind === "bad_deterministic") receipt.result_handle = forgedHandle;
          if (kind === "wrong_run") receipt.run_id = "run-two";
          if (kind === "wrong_target") receipt.selected_target = { fingerprint: "sha256:bad", handle: selected.handle };
          if (kind === "wrong_descriptor") receipt.descriptor_digest = `sha256:${"d".repeat(64)}`;
          return { receipt: receipt as never, receiptBytes: resolved.receiptBytes };
        }
      };
      const destination = `${directory}/${kind}.tar`;
      const rawOptions = { authorityStore: await initializeEvidenceExportAuthorityStore(`${directory}/export-store`), artifactIdentityStore: identities, context, executor, exportExecutor: async () => { throw new Error("export must not run"); }, helperArtifactBundle: { operation_handle: kind === "wrong_operation" ? forgedHandle : artifactClaim.claim.operationHandle, request_digest: kind === "wrong_request" ? `sha256:${"e".repeat(64)}` : artifactClaim.claim.requestDigest, result_handle: kind === "wrong_bundle_result" ? forgedHandle : resultHandle }, helperArtifactManifestDigest: kind === "wrong_manifest" ? `sha256:${"d".repeat(64)}` : manifest, helperArtifactContract: kind === "wrong_contract" ? "bad" : EVIDENCE_EXPORT_HELPER_CONTRACT, journal: proxy };
      if (kind === "wrong_contract") {
        expect(() => createEvidenceExportOperations(rawOptions)).toThrow("Evidence-volume export failed");
        expect(calls.some((args) => args[2] === "image" || args[2] === "container")).toBe(false);
        continue;
      }
      const operations = createEvidenceExportOperations(rawOptions);
      await expect(operations.execute(exportRequest, destination)).rejects.toThrow("Evidence-volume export failed");
      expect(calls.some((args) => args[2] === "image" || args[2] === "container"), kind).toBe(false);
      await expect(readFile(destination)).rejects.toThrow();
    }
  }, 15_000);
});
